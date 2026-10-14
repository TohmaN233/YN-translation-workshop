import {createServer} from 'node:http';

const checks={readingOrder:true,paragraphs:true,tables:true,figures:true,protectedContent:true};
const plain=content=>typeof content==='string'?content:(content??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');

/** A loopback OpenAI wire fixture. Real Pi dispatches the production tools;
 * this adapter never invokes them itself or fabricates source/receipt data. */
export async function createPdfStructureHttpProvider({onRecord=()=>{}}={}) {
  let mode='valid',sequence=0;
  const records=[];
  const record=value=>{records.push(value);onRecord(value);};
  const server=createServer(async(request,response)=>{
    try {
      if(request.method==='POST'&&request.url==='/fixture/mode') {
        let input='';for await(const chunk of request)input+=chunk;
        const value=JSON.parse(input).mode;
        if(!['valid','malformed','audit-reject','hold'].includes(value))throw Error('Unknown local fixture mode.');
        mode=value;response.writeHead(200,{'content-type':'application/json'});response.end('{"ok":true}');return;
      }
      if(request.method==='GET'&&request.url==='/fixture/records') {response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(records));return;}
      if(request.method!=='POST'||!request.url.endsWith('/chat/completions')) {
        response.writeHead(404,{'content-type':'application/json'});response.end(JSON.stringify({error:'Only the local chat completion fixture is available.'}));return;
      }
      let bytes='';for await(const chunk of request)bytes+=chunk;
      const body=JSON.parse(bytes),tools=new Set((body.tools??[]).map(tool=>tool.function.name));
      const phase=tools.has('readPdfPreparedStructure')?'audit':tools.has('readPdfStructureDraft')?'proposal':'task';
      const number=++sequence,entry={number,phase,mode,tools:[...tools],at:Date.now()};record(entry);
      response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
      const chunk=(delta,finish_reason=null)=>response.write(`data: ${JSON.stringify({id:`pdf-wire-${number}`,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'pdf-fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);
      chunk({role:'assistant'});
      if(mode==='hold'||phase==='task') {response.once('close',()=>record({number,phase,event:'stream-closed',at:Date.now()}));return;}
      const calls=new Map();
      for(const message of body.messages??[])for(const call of message.tool_calls??[])calls.set(call.id,{name:call.function.name,args:JSON.parse(call.function.arguments||'{}')});
      const results=(name)=>(body.messages??[]).filter(message=>message.role==='tool'&&calls.get(message.tool_call_id)?.name===name).map(message=>({call:calls.get(message.tool_call_id),value:JSON.parse(plain(message.content))}));
      const nextRead=name=>{
        const seen=results(name),total=seen.at(-1)?.value.total;
        if(total===undefined)return {name,args:{fromLine:1,toLine:1}};
        const owned=new Set(seen.flatMap(result=>result.value.rows.map(row=>row.physicalLine??row.logicalLine??row.line)));
        for(let start=1;start<=total;start++)if(!owned.has(start))return {name,args:{fromLine:start,toLine:Math.min(total,start+499)}};
      };
      const nextPacketRead=()=>{
        const name='readPdfStructureAuditScope',seen=results(name),total=seen.at(-1)?.value.total;
        if(total===undefined)return {name,args:{fromRecord:1,toRecord:1}};
        const owned=new Set(seen.flatMap(result=>Array.from({length:result.call.args.toRecord-result.call.args.fromRecord+1},(_,offset)=>result.call.args.fromRecord+offset)));
        for(let start=1;start<=total;start++)if(!owned.has(start))return {name,args:{fromRecord:start,toRecord:Math.min(total,start+499)}};
      };
      let action=phase==='audit'&&tools.has('readPdfStructureAuditScope')?nextPacketRead():nextRead('readPdfStructureSource');
      if(!action&&phase==='audit'&&!tools.has('readPdfStructureAuditScope'))action=nextRead('readPdfPreparedStructure');
      if(!action&&phase==='audit'&&!results('submitPdfStructureAudit').length)action={name:'submitPdfStructureAudit',args:{version:1,
        checks:{...checks,...(mode==='audit-reject'?{paragraphs:false}:{})},issues:mode==='audit-reject'?[{physicalLines:[1],message:'Explicit local independent audit rejection.'}]:[],...(mode==='audit-reject'?{unsupported:{reason:'The local verification fixture deliberately declares this source structure unsupported.'}}:{})}};
      if(!action&&phase==='proposal') {
        const draft=results('readPdfStructureDraft');
        if(!draft.length)action={name:'readPdfStructureDraft',args:{fromParagraph:1,toParagraph:1}};
        else {
          const total=draft.at(-1).value.total,covered=draft.reduce((sum,result)=>sum+result.value.paragraphs.length,0);
          if(covered<total)action={name:'readPdfStructureDraft',args:{fromParagraph:covered+1,toParagraph:Math.min(total,covered+500)}};
          else if(!results('revisePdfStructureDraft').length) {
            const owner=draft[0].value.paragraphs[0];
            action={name:'revisePdfStructureDraft',args:{expectedRevision:draft.at(-1).value.revision,paragraphs:[{...owner,reason:'Local fixture inspected these source IDs and confirmed their retained ownership.'}]}};
          } else if(!results('checkPdfStructureDraft').length)action={name:'checkPdfStructureDraft',args:{}};
        }
      }
      if(action) {
        record({number,phase,event:'tool-request',name:action.name,args:action.args,at:Date.now()});
        chunk({tool_calls:[{index:0,id:`pdf-tool-${number}`,type:'function',function:{name:action.name,arguments:JSON.stringify(action.args)}}]});
        chunk({},'tool_calls');
      } else {
        let value;
        if(phase==='proposal') {
          const checked=results('checkPdfStructureDraft').at(-1)?.value;
          if(!checked?.valid)throw Error(`Host draft check did not succeed: ${JSON.stringify(checked)}`);
          value={version:1,useDraft:true,revision:checked.revision+(mode==='malformed'?1:0),audit:{...checks,issues:[]}};
        } else value=results('submitPdfStructureAudit').at(-1).call.args;
        record({number,phase,event:'completed',value,at:Date.now()});
        chunk({content:phase==='audit'?'Audit submitted.':JSON.stringify(value)});chunk({},'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch(error) {
      record({event:'fixture-error',message:String(error),at:Date.now()});
      if(!response.headersSent)response.writeHead(500,{'content-type':'application/json'});
      response.end(JSON.stringify({error:String(error)}));
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  return {baseUrl:`http://127.0.0.1:${port}/v1`,controlUrl:`http://127.0.0.1:${port}`,records,setMode(value){if(!['valid','malformed','audit-reject','hold'].includes(value))throw Error('Unknown PDF HTTP fixture mode.');mode=value;},
    config:{id:'pdf-local',presetId:'custom-api',type:'openai_compatible',name:'Local PDF verification',model:'pdf-fixture',models:['pdf-fixture'],enabled:true,supportsImages:true,baseUrl:`http://127.0.0.1:${port}/v1`,auth:{kind:'api_key',key:'local-test-only'}},
    async close(){await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
