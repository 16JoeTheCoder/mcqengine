import { describe, expect, it, vi } from 'vitest';
import { checkBatch, extractBatch, selectedPages, makePack, abortableDelay } from '../../src/lib/ai/import';
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

describe('AI batch requests',()=>{
  it('uses authenticated same-origin calls and retries provider throttling',async()=>{
    const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({error:'Busy'}),{status:429,headers:{'Retry-After':'0'}})).mockResolvedValueOnce(new Response(JSON.stringify(batch)));
    const result = await extractBatch([{page:2,role:'question',text:'source'}],false,'session-token',new AbortController().signal,request);
    expect(result.questions[0]!.answer).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]![0]).toBe('/api/ai/extract');
    expect(request.mock.calls[0]![1].headers.Authorization).toBe('Bearer session-token');
    expect(JSON.stringify(request.mock.calls)).not.toContain('NVIDIA_API_KEY');
  });
  it('does not retry invalid schema or authorization failures',async()=>{
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'Sign in'}),{status:401}));
    await expect(extractBatch([],false,'token',new AbortController().signal,request)).rejects.toThrow('Sign in');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('honors long Retry-After by returning control without immediate retries',async()=>{
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'Try later'}),{status:429,headers:{'Retry-After':'120'}}));
    await expect(extractBatch([],false,'token',new AbortController().signal,request)).rejects.toThrow('Try later');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('cancels retry waits and prevents additional requests',async()=>{
    const abort = new AbortController();
    const request = vi.fn().mockImplementation(async()=>{ setTimeout(()=>abort.abort(),1); return new Response('{}',{status:503}); });
    await expect(extractBatch([],false,'token',abort.signal,request)).rejects.toMatchObject({name:'AbortError'});
    expect(request).toHaveBeenCalledTimes(1);
    await expect(abortableDelay(100,abort.signal)).rejects.toMatchObject({name:'AbortError'});
  });
});
