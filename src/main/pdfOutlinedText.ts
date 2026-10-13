/** Some design-tool PDFs draw outlined glyphs, followed by a selectable Type3
 * layer with empty charprocs. Only an adjacent, identically transformed graphics
 * group may own those outlines. Ambiguous ownership must stop extraction.
 */
export function pdfOutlinedText(ops: {fnArray:number[];argsArray:any[]}, codes: Record<string,number>,
  fontFor: (id:string)=>any, retained: Set<number>, page:number,
  items: Array<{transform:number[];width:number;paintOperations?:number[]}>) {
  type Group={matrix:number[];paths:number[];boxes:number[][];text:number[];unsupported:boolean;parent?:Group;owner?:Group};
  const identity=[1,0,0,1,0,0];
  const apply=(m:number[],n:number[])=>[m[0]*n[0]+m[2]*n[1],m[1]*n[0]+m[3]*n[1],m[0]*n[2]+m[2]*n[3],m[1]*n[2]+m[3]*n[3],m[0]*n[4]+m[2]*n[5]+m[4],m[1]*n[4]+m[3]*n[5]+m[5]];
  const stack:Array<{group:Group;font:any}>=[];
  let group:Group={matrix:identity,paths:[],boxes:[],text:[],unsupported:false}, previous:Group|undefined, font:any;
  const hidden=new Set<number>(), paired=new Set<number>();
  const owners=new Map<number,number[]>();
  const finish=()=>{
    if(!group.text.length)return;
    const owner=group.owner;
    if(!owner || owner.parent!==group.parent || owner.text.length || owner.unsupported
      || group.paths.length || !owner.paths.length
      || owner.matrix.some((value,index)=>Math.abs(value-group.matrix[index])>1e-6)) {
      throw new Error(`PDF page ${page}: outlined text has no unambiguous adjacent glyph-path owner (text operations ${group.text.join(",")}, prior paths ${owner?.paths.join(",")??"none"}).`);
    }
    const kinds=new Set(group.text.map(index=>retained.has(index)));
    if(kinds.size!==1)throw new Error(`PDF page ${page}: outlined glyph paths mix protected content with prose; safe separation is required.`);
    const textItems=items.filter(item=>item.paintOperations?.some(index=>group.text.includes(index)));
    if(!textItems.length || group.text.some(index=>!textItems.some(item=>item.paintOperations?.includes(index)))) {
      throw new Error(`PDF page ${page}: outlined text has no complete glyph geometry binding.`);
    }
    // Text-content transforms include the actual text matrix and font scale,
    // unlike graphics CTM alone. A nearby decoration is never a glyph owner.
    const boxes=textItems.map(item=>{
      const size=Math.hypot(item.transform[2],item.transform[3]),x=item.transform[4],y=item.transform[5];
      return [x-size*.25,y-size*.3,x+item.width+size*.25,y+size*1.2];
    });
    const envelope=[Math.min(...boxes.map(box=>box[0])),Math.min(...boxes.map(box=>box[1])),
      Math.max(...boxes.map(box=>box[2])),Math.max(...boxes.map(box=>box[3]))];
    if(owner.boxes.some(box=>box[0]<envelope[0] || box[1]<envelope[1] || box[2]>envelope[2] || box[3]>envelope[3]
      || !boxes.some(text=>box[0]<text[2]&&box[2]>text[0]&&box[1]<text[3]&&box[3]>text[1]))) {
      throw new Error(`PDF page ${page}: adjacent outlines lie outside their actual text glyph region.`);
    }
    for(const index of group.text) owners.set(index,owner.paths);
    for(const index of owner.paths) {
      paired.add(index);
      if(!kinds.has(true))hidden.add(index);
    }
  };
  for(let index=0;index<ops.fnArray.length;index++) {
    const op=ops.fnArray[index],args=ops.argsArray[index];
    if(op===codes.save) {
      stack.push({group,font});
      group={matrix:[...group.matrix],paths:[],boxes:[],text:[],unsupported:false,parent:group,owner:previous};previous=undefined;
    } else if(op===codes.restore) {
      finish();
      const state=stack.pop();
      if(!state)throw new Error(`PDF page ${page}: outlined text graphics state is unbalanced.`);
      const finished=group;
      group=state.group;font=state.font;previous=finished;
    } else if(op===codes.transform)group.matrix=apply(group.matrix,args);
    else if(op===codes.setFont)font=fontFor(args[0]);
    else if(op===codes.constructPath && args[2]) {
      previous=undefined;
      if(args[0]!==codes.fill && args[0]!==codes.eoFill)group.unsupported=true;
      group.paths.push(index);
      const box=args[2],m=group.matrix;
      const points=[[box[0],box[1]],[box[0],box[3]],[box[2],box[1]],[box[2],box[3]]]
        .map(([x,y])=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]]);
      group.boxes.push([Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),
        Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))]);
    } else if(op===codes.showText || op===codes.showSpacedText) {
      const glyphs=args[0].filter((glyph:any)=>typeof glyph==='object');
      if(font?.isType3Font && glyphs.some((glyph:any)=>String(glyph.unicode??'').trim())) {
        const empty=glyphs.every((glyph:any)=>{
          const charProc=font.charProcOperatorList.get(glyph.operatorListId);
          return charProc && charProc.fnArray.every((fn:number)=>fn===codes.setCharWidth || fn===codes.setCharWidthAndBounds);
        });
        if(empty)group.text.push(index);
      }
    } else if([codes.clip,codes.eoClip,codes.paintFormXObjectBegin,codes.paintFormXObjectEnd,codes.paintImageXObject,codes.paintInlineImageXObject,codes.paintImageMaskXObject,codes.beginGroup,codes.endGroup].includes(op)) {
      group.unsupported=true;previous=undefined;
    }
  }
  if(stack.length)throw new Error(`PDF page ${page}: outlined text graphics state is unbalanced.`);
  finish();
  return {hidden,paired,owners};
}
