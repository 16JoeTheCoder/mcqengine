import { expect, test } from './fixtures';
import { makePdf } from '../fixtures/pdf';

const ndjson=(...lines:unknown[])=>lines.map(l=>JSON.stringify(l)).join('\n')+'\n';

test('AI PDF import requires consent, preserves unkeyed answers, and reuses pack review',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('dmc-mock-account',JSON.stringify({id:'mock-ai-user',email:'ai@example.com',name:'AI test',emailVerified:true})));
  await page.route('**/api/ai/config',route=>route.fulfill({json:{configured:true,model:'mock-vision',maxPagesPerBatch:4,maxPayloadBytes:4_000_000,maxTextChars:60_000,maxImageBytes:1_000_000}}));
  let calls=0;
  await page.route('**/api/ai/run',async route=>{
    calls++;
    // Only a task name and its inputs: the server owns the prompt.
    expect(Object.keys(route.request().postDataJSON()).sort()).toEqual(['input','task']);
    expect(route.request().postDataJSON()).toMatchObject({task:'extract',input:{hasMarkScheme:false,pages:[{page:1,role:'question'}]}});
    expect(route.request().headers()['x-dmc']).toBe('1');
    await route.fulfill({contentType:'application/x-ndjson',body:ndjson({type:'queued',position:1},{type:'result',data:{questions:[{n:1,page:1,stem:'A synthetic AI question. Which option is correct?',options:['One','Two','Three','Four'],answer:'A'}],warnings:[]}})});
  });
  await page.goto('./');
  await expect(page.getByRole('button',{name:'Account: ai@example.com'})).toBeVisible();
  await page.getByRole('button',{name:/Import a paper-set file|Upload papers/}).first().click();
  await page.getByRole('button',{name:'Import PDF with AI',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Import PDF with AI'});
  const file=Buffer.from(makePdf([['Synthetic question paper','1 Which value is correct? A One B Two C Three D Four','This document contains only synthetic educational material.']]));
  await dialog.getByLabel('Question paper PDF',{exact:true}).setInputFiles({name:'synthetic-ai.pdf',mimeType:'application/pdf',buffer:file});
  await expect(dialog.getByLabel(/Question pages/)).toHaveValue('1-1');
  const start=dialog.getByRole('button',{name:'Start extraction / resume'});
  await expect(start).toBeDisabled();
  expect(calls).toBe(0);
  await dialog.getByLabel(/I agree to send/).check();
  await start.click();
  await expect(dialog.getByText('1 unkeyed',{exact:true})).toBeVisible();
  await expect(dialog.getByRole('link',{name:'Open original question paper'})).toHaveAttribute('href',/blob:.*#page=1/);
  const extraction=JSON.parse(await dialog.getByLabel('Editable extraction').inputValue());
  expect(extraction.papers[0].questions[0].answer).toBeNull();
  expect(extraction.papers[0].questions[0].page).toBe(1);
  await dialog.getByRole('button',{name:'Validate and review import'}).click();
  await expect(page.getByText('Valid',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/Review import/}).click();
  await expect(page.getByRole('dialog',{name:'Review import'})).toBeVisible();
  expect(calls).toBe(1);
});

test('AI import configuration errors preserve the manual import path',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('dmc-mock-account',JSON.stringify({id:'mock-ai-user',email:'ai@example.com',name:'AI test',emailVerified:true})));
  await page.route('**/api/ai/config',route=>route.fulfill({json:{configured:false}}));
  await page.goto('./');
  await page.getByRole('button',{name:/Import a paper-set file|Upload papers/}).first().click();
  await page.getByRole('button',{name:'Import PDF with AI',exact:true}).click();
  await expect(page.getByText(/needs a model and NVIDIA Worker secret/)).toBeVisible();
  await page.getByRole('button',{name:'Manual import',exact:true}).click();
  await expect(page.getByRole('button',{name:'PDF papers',exact:true})).toBeVisible();
});

test('retry resumes completed pages from the account workspace without duplicate questions',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('dmc-mock-account',JSON.stringify({id:'mock-ai-user',email:'ai@example.com',name:'AI test',emailVerified:true})));
  await page.route('**/api/ai/config',route=>route.fulfill({json:{configured:true,model:'mock-vision',maxPagesPerBatch:4,maxPayloadBytes:4_000_000,maxTextChars:60_000,maxImageBytes:1_000_000}}));
  const calls:number[]=[];
  let failed=false;
  await page.route('**/api/ai/run',async route=>{
    const n=route.request().postDataJSON().input.pages[0].page as number; calls.push(n);
    if(n===2 && !failed){failed=true;return route.fulfill({contentType:'application/x-ndjson',body:ndjson({type:'error',status:422,error:'Synthetic failed batch. Resume to retry.'})});}
    return route.fulfill({contentType:'application/x-ndjson',body:ndjson({type:'result',data:{questions:[{n,page:n,stem:`Synthetic question ${n}`,options:['One','Two','Three','Four'],answer:null}],warnings:[]}})});
  });
  await page.goto('./');
  await page.getByRole('button',{name:/Import a paper-set file|Upload papers/}).first().click();
  await page.getByRole('button',{name:'Import PDF with AI',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Import PDF with AI'});
  const file={name:'recovery.pdf',mimeType:'application/pdf',buffer:Buffer.from(makePdf([['Synthetic page one'],['Synthetic page two']]))};
  await dialog.getByLabel('Question paper PDF',{exact:true}).setInputFiles(file);
  await dialog.getByLabel(/I agree to send/).check();
  await dialog.getByRole('button',{name:'Start extraction / resume'}).click();
  await expect(dialog.getByRole('alert')).toHaveText('Synthetic failed batch. Resume to retry.');
  await dialog.getByRole('button',{name:'Manual import',exact:true}).click();
  await page.getByRole('button',{name:'Import PDF with AI',exact:true}).click();
  await dialog.getByLabel('Question paper PDF',{exact:true}).setInputFiles(file);
  await dialog.getByLabel(/I agree to send/).check();
  await dialog.getByRole('button',{name:'Start extraction / resume'}).click();
  await expect(dialog.getByText('2 extracted',{exact:true})).toBeVisible();
  expect(calls).toEqual([1,2,2]);
  const extraction=JSON.parse(await dialog.getByLabel('Editable extraction').inputValue());
  expect(extraction.papers[0].questions.map((q:{n:number})=>q.n)).toEqual([1,2]);
});
