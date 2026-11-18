import { describe, expect, it, vi } from 'vitest';
import { checkBatch, extractBatch, selectedPages, makePack, abortableDelay } from '../../src/lib/ai/import';
import { createCloudflareBackend } from '../../src/lib/backend/cloudflare';
import { parseImport } from '../../src/lib/data/importer';
import type { PDFDocumentProxy } from 'pdfjs-dist';

const q = { n:1, page:2, stem:'Which value?',options:['One','Two','Three','Four'],answer:'A' };
const batch = {questions:[q],warnings:[]};

describe('AI import trust boundary',()=>{
  it('bounds explicit page selection and deduplicates overlaps',()=>{
    expect(selectedPages('2-4, 3, 8',10,5)).toEqual([2,3,4,8]);
    for (const value of ['','0','1-200','9-2','1;fetch()','11','1-3,4-6']) expect(()=>selectedPages(value,10,5)).toThrow();
  });
  it('leaves all answers unkeyed without a mark scheme',()=>{
    expect(checkBatch(batch,[2],false).questions[0]!.answer).toBeNull();
    expect(checkBatch(batch,[2],true).questions[0]!.answer).toBe('A');
  });
  it('rejects unknown fields, missing options, invalid answer indices, source pages and crops',()=>{
    for (const patch of [{tool:'run'},{options:['one']},{answer:'E'},{page:20},{crop:{x:.9,y:0,w:.5,h:1}},{table:{columns:['A'],rows:[]}}]) {
      expect(()=>checkBatch({...batch,questions:[{...q,...patch}]},[2],true)).toThrow();
    }
  });
  it('builds the existing pack format and flags duplicate and missing numbers',async()=>{
    const result = await makePack([{questions:[{...q,n:3},{...q,n:3}],warnings:[]}],{} as PDFDocumentProxy,'Test',false);
    expect(result.warnings.join(' ')).toMatch(/Duplicate question numbers/);
    expect(result.warnings.join(' ')).toMatch(/not extracted: 1, 2/);
    expect(result.summary).toEqual({extracted:2,unkeyed:2,missingFigures:0,needsReview:2});
    expect(parseImport(result.text).ok).toBe(true);
    const clean = await makePack([{questions:[{...q,n:1}],warnings:[]}],{} as PDFDocumentProxy,'Test',false);
    const outcome = parseImport(clean.text,new Set(['pdfs/question.pdf']));
    expect(outcome.ok && outcome.result.errors).toEqual([]);
  });
});

const ndjson = (...lines: unknown[]) => new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
const be = (request: ReturnType<typeof vi.fn>) => createCloudflareBackend({ fetchImpl: request as unknown as typeof fetch });

describe('AI batch requests',()=>{
  it('sends only a task name and inputs, shows queue position, and retries throttling',async()=>{
    const request = vi.fn().mockResolvedValueOnce(ndjson({type:'error',status:429,error:'Busy',retryAfter:0.001})).mockResolvedValueOnce(ndjson({type:'queued',position:2},{type:'result',data:batch}));
    const queue: (number|null)[] = [];
    const result = await extractBatch(be(request),[{page:2,role:'question',text:'source'}],false,new AbortController().signal,(p)=>queue.push(p));
    expect(result.questions[0]!.answer).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]![0]).toBe('/api/ai/run');
    const body = JSON.parse(request.mock.calls[0]![1].body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['input','task']);
    expect(body.task).toBe('extract');
    expect(queue).toEqual([2]);
    expect(JSON.stringify(request.mock.calls)).not.toMatch(/NVIDIA_API_KEY|system/);
  });
  it('does not retry validation or authorization failures',async()=>{
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'Sign in first'}),{status:401}));
    await expect(extractBatch(be(request),[],false,new AbortController().signal)).rejects.toThrow('Sign in');
    expect(request).toHaveBeenCalledTimes(1);
    const bad = vi.fn().mockResolvedValue(ndjson({type:'error',status:422,error:'still had problems'}));
    await expect(extractBatch(be(bad),[],false,new AbortController().signal)).rejects.toThrow('still had problems');
    expect(bad).toHaveBeenCalledTimes(1);
  });
  it('honours a long Retry-After and a used-up daily allowance by returning control',async()=>{
    const request = vi.fn().mockResolvedValue(ndjson({type:'error',status:429,error:'Try later',retryAfter:120}));
    await expect(extractBatch(be(request),[],false,new AbortController().signal)).rejects.toThrow('Try later');
    expect(request).toHaveBeenCalledTimes(1);
    const daily = vi.fn().mockResolvedValue(ndjson({type:'error',status:429,error:'Daily AI allowance reached',retryAfter:1}));
    await expect(extractBatch(be(daily),[],false,new AbortController().signal)).rejects.toThrow('allowance');
    expect(daily).toHaveBeenCalledTimes(1);
  });
  it('cancels retry waits and prevents additional requests',async()=>{
    const abort = new AbortController();
    const request = vi.fn().mockImplementation(async()=>{ setTimeout(()=>abort.abort(),1); return ndjson({type:'error',status:503,error:'busy',retryAfter:1}); });
    await expect(extractBatch(be(request),[],false,abort.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(request).toHaveBeenCalledTimes(1);
    await expect(abortableDelay(100,abort.signal)).rejects.toMatchObject({name:'AbortError'});
  });
});
