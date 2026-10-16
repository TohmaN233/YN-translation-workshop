import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { load } from 'cheerio';

const directory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(directory,'../..');
const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const site='https://tohman233.github.io/YN-translation-workshop/';
const repo='https://github.com/TohmaN233/YN-translation-workshop/';
const h=React.createElement;
const pages=[
  {id:'overview',file:'index',md:'README',zh:'认识 YN',en:'Overview',section:'home'},
  {id:'guides',file:'guides',md:'docs/guide',zh:'第一次使用',en:'First run',section:'tutorial'},
  {id:'features',file:'features',md:'docs/features',zh:'功能与参数',en:'Features and settings',section:'tutorial'},
  {id:'pdf',file:'pdf',md:'docs/pdf',zh:'PDF 翻译',en:'PDF translation',section:'tutorial'},
  {id:'api',file:'agent-api',md:'docs/agent-api',zh:'后台 Agent API',en:'Background Agent API',section:'tutorial'},
  {id:'examples',file:'examples',md:'docs/examples',zh:'翻译项目例子',en:'Project examples',section:'evidence'},
  {id:'quality',file:'quality',md:'docs/quality',zh:'质量检查',en:'Quality checks',section:'evidence'},
  {id:'workflows',file:'workflows',md:'docs/workflows',zh:'流程与恢复',en:'Workflows and recovery',section:'technical'},
  {id:'harness',file:'harness',md:'docs/architecture',zh:'Harness 架构',en:'Harness architecture',section:'technical'},
  {id:'development',file:'development',md:'docs/development',zh:'开发与验证',en:'Development and validation',section:'technical'},
  {id:'functions',file:'functions',md:'docs/reference',zh:'Function 参考',en:'Function reference',section:'technical'},
  {id:'terminology',file:'terminology',md:'docs/terminology',zh:'Agent 术语',en:'Agent terminology',section:'technical'},
  {id:'changelog',file:'changelog',md:'CHANGELOG',zh:'版本记录',en:'Changelog',section:'technical'}
];
const fileName=(page,en)=>page.file+(en?'.en':'')+'.html';
const mdName=(page,en)=>page.md+(en?'.en':'')+'.md';
const sourceMap=new Map(pages.flatMap(page=>[false,true].map(en=>[mdName(page,en),fileName(page,en)])));
const assetMap=new Map([['docs/yn-guide/robots-root-template.txt','robots-root-template.txt']]);
const slug=text=>text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'');
const textOf=node=>node.value??node.children?.map(textOf).join('')??'';
const index=[];
const pageMetadata=(markdown,sourceFile)=>{
  const prepared=markdown.replace(/<div align="left">[\s\S]*?<\/div>/,header=>{
    const heading=load(header)('h1').first().text().trim();
    if(!heading)throw new Error('README header is missing its H1: '+sourceFile);
    return '# '+heading;
  });
  const lines=prepared.split('\n'),metadataLines=[];
  for(let i=0,fenced=false;i<lines.length;){
    if(lines[i].trim().startsWith(String.fromCharCode(96).repeat(3)))fenced=!fenced;
    if(!fenced&&lines[i].trim().startsWith('|')&&/^\s*\|?[\s:|-]+\|\s*$/.test(lines[i+1]??'')&&lines[i+1].includes('---')){
      i+=2;while(i<lines.length&&lines[i].trim().startsWith('|'))i++;
    }else metadataLines.push(lines[i++]);
  }
  const $=load(renderToStaticMarkup(h(Markdown,{skipHtml:true},metadataLines.join('\n'))));
  const title=$('h1').first().text().replace(/\s+/g,' ').trim();
  if(!title)throw new Error('Markdown page is missing its H1: '+sourceFile);
  const summary=$('p').toArray().map(node=>{
    const paragraph=$(node),text=paragraph.text().replace(/\s+/g,' ').trim();
    if(!text)return '';
    const prose=paragraph.clone();prose.find('a, img').remove();
    if(!prose.text().replace(/[\s·•|—–-]+/gu,'').trim())return '';
    return text;
  }).find(Boolean)??'';
  if(!summary)throw new Error('Markdown page is missing descriptive prose: '+sourceFile);
  return {markdown:prepared,title,summary};
};

for(const page of pages)for(const en of [false,true]){
  const sourceFile=mdName(page,en),file=fileName(page,en),lang=en?'en':'zh-CN';
  const markdown=await readFile(path.join(root,sourceFile),'utf8');
  const metadata=pageMetadata(markdown,sourceFile);
  const headings=[],seen=new Map();
  const resolveLink=href=>{
    if(!href||/^(?:https?:|mailto:|#)/.test(href))return href;
    const [location,hash]=href.split('#');
    const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile),location));
    const mapped=sourceMap.get(resolved)??assetMap.get(resolved);
    return (mapped??repo+'blob/main/'+resolved)+(hash?'#'+hash:'');
  };
  const resolveImage=src=>{
    if(/^https?:/.test(src))return src;
    const resolved=path.resolve(root,path.dirname(sourceFile),src);
    const relative=path.relative(directory,resolved).replaceAll(path.sep,'/');
    if(relative.startsWith('../'))throw new Error('Guide image is outside the existing guide assets: '+src);
    return relative;
  };
  const aliases=new Map([
    ['启动翻译','translation'],['Start translating','translation'],['使用已有译文','reuse'],['Existing translations','reuse'],
    ['校对与写出','proofread'],['Proofread and write','proofread'],['手机与局域网','lan'],['Phones and LAN','lan'],
    ['译名表与角色表','assets'],['Glossary and characters','assets'],['PDF、代码和公式','pdf'],['PDF, code and formulas','pdf']
  ]);
  const components={
    a:({node,...props})=>h('a',{...props,href:resolveLink(props.href)}),
    img:({node,...props})=>h('img',{...props,src:resolveImage(props.src),loading:'lazy',decoding:'async'}),
    ...Object.fromEntries([1,2,3,4].map(level=>['h'+level,({node,children})=>{
      const text=textOf(node),base=aliases.get(text)??slug(text),count=seen.get(base)??0;seen.set(base,count+1);
      const id=base+(count?'-'+count:'');if(level===2||level===3)headings.push({id,text,level});
      return h('h'+level,{id},children);
    }]))
  };
  const render=text=>renderToStaticMarkup(h(Markdown,{components,skipHtml:true},text));
  const cell=text=>render(text.trim()).replace(/^<p>|<\/p>$/g,'');
  // Existing React Markdown handles prose; tables are rendered here without
  // installing another Markdown runtime. Fenced code is never table-parsed.
  const lines=metadata.markdown.split('\n');
  let body='',buffer=[],fenced=false;
  const flush=()=>{if(buffer.length){body+=render(buffer.join('\n'));buffer=[];}};
  for(let i=0;i<lines.length;i++){
    if(lines[i].trim().startsWith(String.fromCharCode(96).repeat(3)))fenced=!fenced;
    if(!fenced&&lines[i].trim().startsWith('|')&&/^\s*\|?[\s:|-]+\|\s*$/.test(lines[i+1]??'')&&lines[i+1].includes('---')){
      flush();const split=line=>line.trim().replace(/^\||\|$/g,'').split('|');
      const header=split(lines[i]);i+=2;const rows=[];
      while(i<lines.length&&lines[i].trim().startsWith('|')){rows.push(split(lines[i]));i++;}i--;
      body+='<div class="table-scroll"><table><thead><tr>'+header.map(value=>'<th>'+cell(value)+'</th>').join('')+'</tr></thead><tbody>'
        +rows.map(row=>'<tr>'+row.map(value=>'<td>'+cell(value)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
    }else buffer.push(lines[i]);
  }flush();
  const title=page[en?'en':'zh'],other=fileName(page,!en);
  const seoTitle=page.id==='overview'?metadata.title+' · '+version:metadata.title+' · YN Translation Workshop '+version;
  const descriptionMeta=metadata.summary?h('meta',{name:'description',content:metadata.summary}):null;
  const labels=en?{home:'Project',tutorial:'Using YN',evidence:'Examples and evidence',technical:'Technical reference'}:{home:'项目',tutorial:'使用 YN',evidence:'案例与证据',technical:'技术参考'};
  const nav=Object.keys(labels).map(section=>h('section',{className:'nav-section',key:section},h('p',{className:'nav-label'},labels[section]),
    pages.filter(item=>item.section===section).map(item=>h('a',{className:'nav-link'+(page.id===item.id?' active':''),href:fileName(item,en),key:item.id},item[en?'en':'zh']))));
  const html=h('html',{lang},h('head',null,
    h('meta',{charSet:'utf-8'}),h('meta',{name:'viewport',content:'width=device-width, initial-scale=1'}),
    descriptionMeta,h('meta',{name:'robots',content:'index,follow'}),
    h('meta',{httpEquiv:'Content-Security-Policy',content:"default-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://img.shields.io;"}),
    h('link',{rel:'canonical',href:site+file}),h('link',{rel:'alternate',hrefLang:'zh-CN',href:site+fileName(page,false)}),h('link',{rel:'alternate',hrefLang:'en',href:site+fileName(page,true)}),
    h('link',{rel:'icon',href:'assets/app-icon.png'}),h('link',{rel:'stylesheet',href:'styles.css'}),
    h('script',{src:'content.js',defer:true}),h('script',{src:'app.js',defer:true}),h('title',null,seoTitle)),
    h('body',{'data-page':page.id,'data-locale':en?'en':'zh','data-version':version},
      h('header',{className:'topbar'},h('a',{className:'brand',href:fileName(pages[0],en)},h('img',{src:'assets/app-icon.png',alt:'YN'}),h('strong',null,'YN Translation Workshop')),
        h('button',{className:'search-trigger',type:'button','data-search-open':true},en?'Search docs':'搜索文档'),
        h('div',{className:'topmeta'},h('span',null,version),h('a',{href:other,hrefLang:en?'zh-CN':'en'},en?'中文':'English'),h('button',{type:'button',className:'menu-button','data-menu':true,'aria-label':en?'Navigation':'导航'},'☰'))),
      h('aside',{className:'sidebar','aria-label':en?'Documentation navigation':'文档导航'},...nav,h('div',{className:'sidebar-foot'},(en?'Docs for ':'文档对应 ')+version)),
      h('main',{className:'layout'},h('article',{className:'content',id:'content','data-source':sourceFile,dangerouslySetInnerHTML:{__html:body}})),
      h('aside',{className:'toc'},h('strong',null,en?'On this page':'本页目录'),h('div',{id:'toc-links'},...headings.map(heading=>h('a',{href:'#'+heading.id,className:'level-'+heading.level,key:heading.id},heading.text)))),
      h('dialog',{className:'search-dialog',id:'search-dialog'},h('div',{className:'search-head'},h('input',{type:'search',id:'global-search',placeholder:en?'Search title or topic':'搜索标题或内容','aria-label':en?'Search documentation':'搜索文档'}),h('button',{type:'button','data-search-close':true,'aria-label':en?'Close search':'关闭搜索'},'×')),h('div',{className:'search-results',id:'search-results'})),
      h('dialog',{className:'lightbox',id:'lightbox'},h('button',{type:'button','data-lightbox-close':true,'aria-label':en?'Close image':'关闭图片'},'×'),h('img',{alt:en?'Enlarged product screenshot':'放大的产品截图'})),
      h('footer',{className:'doc-footer'},h('a',{href:repo+'releases'},en?'Downloads':'发布下载'),' · ',h('a',{href:repo+'blob/main/'+sourceFile},en?'Markdown source':'Markdown 源文'),' · MIT')
    ));
  await writeFile(path.join(directory,file),'<!doctype html>\n'+renderToStaticMarkup(html)+'\n');
  index.push({locale:en?'en':'zh',file,title,headings,summary:load(body)('body').text().replace(/\s+/g,' ').trim()});
}
await writeFile(path.join(directory,'content.js'),'// Generated from current Markdown by build.mjs; no stale copy overrides.\nwindow.YN_GUIDE = '+JSON.stringify({schemaVersion:4,version,pages:index})+';\n');
await writeFile(path.join(directory,'sitemap.xml'),'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+index.map(page=>'<url><loc>'+site+page.file+'</loc></url>').join('')+'</urlset>\n');
await writeFile(path.join(directory,'robots.txt'),'User-agent: *\nAllow: /\n\nSitemap: '+site+'sitemap.xml\n');
console.log(JSON.stringify({pages:index.length,staticContent:true,languages:['zh-CN','en']}));
