// UI icons + brand. Standalone (needs saveFile, log, fetch).
const R2=v=>Math.round(v*100)/100;
// ---- hand-feel: absolute-ise a path and bow straight segments slightly
function handPath(d,seed){let rnd=seed*7919%1000/1000;const nx=()=>{rnd=(rnd*9301+49297)%233280/233280;return rnd;};
 const tok=d.match(/[MmLlHhVvCcSsQqAaZz]|-?\d*\.?\d+(?:e-?\d+)?/g);let i=0,cmd='',x=0,y=0,sx=0,sy=0,out=[];
 const num=()=>parseFloat(tok[i++]);const isN=()=>i<tok.length&&!/[A-Za-z]/.test(tok[i]);
 const seg=(x1,y1)=>{const l=Math.hypot(x1-x,y1-y);if(l<4.5){out.push(`L${R2(x1)} ${R2(y1)}`);}else{const b=(nx()-0.5)*Math.min(0.55,l*0.05),mx=(x+x1)/2-(y1-y)/l*b,my=(y+y1)/2+(x1-x)/l*b;out.push(`Q${R2(mx)} ${R2(my)} ${R2(x1)} ${R2(y1)}`);}x=x1;y=y1;};
 while(i<tok.length){if(/[A-Za-z]/.test(tok[i]))cmd=tok[i++];const rel=cmd===cmd.toLowerCase(),C=cmd.toUpperCase();
  if(C==='Z'){if(Math.hypot(sx-x,sy-y)>0.01)seg(sx,sy);out.push('Z');x=sx;y=sy;if(!isN()&&i<tok.length&&!/[A-Za-z]/.test(tok[i]))break;continue;}
  do{if(C==='M'){let a=num(),b=num();if(rel){a+=x;b+=y;}x=sx=a;y=sy=b;out.push(`M${R2(a)} ${R2(b)}`);cmd=rel?'l':'L';break;}
   if(C==='L'){let a=num(),b=num();if(rel){a+=x;b+=y;}seg(a,b);}
   else if(C==='H'){let a=num();if(rel)a+=x;seg(a,y);}
   else if(C==='V'){let b=num();if(rel)b+=y;seg(x,b);}
   else if(C==='C'){const p=[num(),num(),num(),num(),num(),num()];if(rel)for(let k=0;k<6;k+=2){p[k]+=x;p[k+1]+=y;}out.push('C'+p.map(R2).join(' '));x=p[4];y=p[5];}
   else if(C==='S'||C==='Q'){const p=[num(),num(),num(),num()];if(rel)for(let k=0;k<4;k+=2){p[k]+=x;p[k+1]+=y;}out.push(C+p.map(R2).join(' '));x=p[2];y=p[3];}
   else if(C==='A'){const p=[num(),num(),num(),num(),num(),num(),num()];if(rel){p[5]+=x;p[6]+=y;}out.push('A'+p.map(R2).join(' '));x=p[5];y=p[6];}
  }while(isN());}
 return out.join('');}
const P=(d)=>({t:'p',d}),Cc=(cx,cy,r,f)=>({t:'c',cx,cy,r,f});
function gear(){const pts=[];for(let k=0;k<8;k++){const a=k*45;for(const[r,da]of[[7.2,-17],[9.5,-9.5],[9.5,9.5],[7.2,17]]){const t=(a+da)*Math.PI/180;pts.push([12+r*Math.cos(t),12+r*Math.sin(t)]);}}return 'M'+pts.map(p=>R2(p[0])+' '+R2(p[1])).join('L')+'Z';}
const ICONS={
 select:[P('M5.5 3.5L5.8 19l4.1-4.3 2.8 5.9 2.7-1.3-2.8-5.8 6.2-.3Z')],
 pan:[P('M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v5.5M17 11.5V9a1.5 1.5 0 0 1 3 0v4.5c0 4-2.7 7-6.5 7H12c-2.3 0-3.8-1-5-2.6L4.2 14.6a1.5 1.5 0 0 1 2.3-1.9L8 14')],
 room:[P('M5 5H19V19H5Z')],
 polygon:[P('M5 8L13 4.5 20 9.5 17 19.5 6.5 17Z'),Cc(5,8,1.7,1),Cc(13,4.5,1.7,1),Cc(20,9.5,1.7,1),Cc(17,19.5,1.7,1),Cc(6.5,17,1.7,1)],
 corridor:[P('M3 4H9.5V10.5H3Z'),P('M14.5 13.5H21V20H14.5Z'),P('M9.5 7.2H12V16.8H14.5')],
 door:[P('M2.5 20.5H21.5'),P('M7 20.5V9a5 5 0 0 1 10 0V20.5'),Cc(14.2,14,1.1,1)],
 pillar:[P('M4 4H20V20H4Z'),Cc(12,12,4,1)],
 stairs:[P('M3 20V16H8V12H13V8H18V4H21V20Z')],
 label:[P('M5 7.5V5H19V7.5M12 5V19M9 19H15')],
 prop:[P('M4 11V8.5C4 6 5.5 5 7.5 5H16.5C18.5 5 20 6 20 8.5V11'),P('M4 11H20V19.5H4Z'),P('M10.5 10H13.5V14H10.5Z')],
 terrain:[P('M20.5 3.5L13.2 10.8'),P('M13.2 10.8c-1.6-1.4-4.1-.9-4.7 1.6-.4 1.6-1.1 2.6-2.7 3.1 3.1 1 6.6.4 7.8-2.6.4-1 .3-1.5-.4-2.1Z'),P('M9.5 21L13.5 17M13.5 21L17.5 17M17.5 21L21 17.5')],
 eraser:[P('M9 20.5H20'),P('M9 20.5L4.4 15.9a1.5 1.5 0 0 1 0-2.1L13.4 4.8a1.5 1.5 0 0 1 2.1 0L20.2 9.5a1.5 1.5 0 0 1 0 2.1L11.3 20.5'),P('M8.9 9.3L15 15.4')],
 undo:[P('M9 14L4 9 9 4'),P('M4 9H14.5a5.5 5.5 0 0 1 0 11H11')],
 redo:[P('M15 14L20 9 15 4'),P('M20 9H9.5a5.5 5.5 0 0 0 0 11H13')],
 'zoom-in':[Cc(10.5,10.5,6.5,0),P('M15.3 15.3L20.5 20.5'),P('M7.5 10.5H13.5M10.5 7.5V13.5')],
 'zoom-out':[Cc(10.5,10.5,6.5,0),P('M15.3 15.3L20.5 20.5'),P('M7.5 10.5H13.5')],
 fit:[P('M4 9V4H9M15 4H20V9M20 15V20H15M9 20H4V15')],
 grid:[P('M4 4H20V20H4Z'),P('M9.33 4V20M14.67 4V20M4 9.33H20M4 14.67H20')],
 eye:[P('M2.5 12C5 7.3 8.4 5 12 5s7 2.3 9.5 7c-2.5 4.7-5.9 7-9.5 7S5 16.7 2.5 12Z'),Cc(12,12,3,0)],
 'eye-off':[P('M2.5 12C5 7.3 8.4 5 12 5s7 2.3 9.5 7c-2.5 4.7-5.9 7-9.5 7S5 16.7 2.5 12Z'),Cc(12,12,3,0),P('M4 3.5L20 20.5')],
 download:[P('M12 3.5V15'),P('M7 10.5L12 15.5 17 10.5'),P('M4 16.5V20H20V16.5')],
 upload:[P('M12 15.5V4'),P('M7 8.5L12 3.5 17 8.5'),P('M4 16.5V20H20V16.5')],
 chat:[P('M6 4.5H18a2 2 0 0 1 2 2V14a2 2 0 0 1-2 2H11L6.5 19.5V16H6a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z')],
 send:[P('M21 3L3 10.5 10 13.5 13.5 21Z'),P('M21 3L10 13.5')],
 stop:[P('M8 6H16a2 2 0 0 1 2 2V16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z')],
 settings:[P(gear()),Cc(12,12,3,0)],
 trash:[P('M4 7H20'),P('M9 7V4.5H15V7'),P('M6 7L7 20H17L18 7'),P('M10 11V16M14 11V16')],
 lock:[P('M7 11H17a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V13a2 2 0 0 1 2-2Z'),P('M8 11V8a4 4 0 0 1 8 0V11'),P('M12 14.5V16.5')],
 unlock:[P('M7 11H17a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V13a2 2 0 0 1 2-2Z'),P('M8 11V8a4 4 0 0 1 7.7-1.5'),P('M12 14.5V16.5')],
 layers:[P('M12 3.5L21 8.3 12 13 3 8.3Z'),P('M3 12.4L12 17.1 21 12.4'),P('M3 16.4L12 21 21 16.4')]};
const ORDER=Object.keys(ICONS);const inner={};let seed=1;
for(const id of ORDER){const els=ICONS[id].map(e=>e.t==='p'?`<path d="${handPath(e.d,seed++)}"/>`:`<circle cx="${e.cx}" cy="${e.cy}" r="${e.r}"${e.f?' fill="currentColor" stroke="none"':''}/>`);inner[id]=els;
 await saveFile(`icons/${id}.svg`,`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">\n  ${els.join('\n  ')}\n</svg>\n`);}
{const n=ORDER.length,bw=40,W=64+n*bw,cols=10,cw=112,gridH=Math.ceil(n/cols)*120,H=64+2*(56+32)+gridH+40;
 const g=(id,x,y,col,s=1)=>`<g transform="translate(${x} ${y})${s!==1?` scale(${s})`:''}" color="${col}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${inner[id].join('')}</g>`;
 let o=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n<rect width="${W}" height="${H}" fill="#F0ECE0"/>\n`;
 const bar=(y,bg,fg,sel)=>{o+=`<rect x="24" y="${y}" width="${n*bw+16}" height="56" rx="10" fill="${bg}"/>\n`;ORDER.forEach((id,k)=>{const x=32+k*bw;if(id==='select')o+=`<rect x="${x}" y="${y+8}" width="${bw}" height="40" rx="7" fill="${sel}"/>\n`;o+=g(id,x+8,y+16,fg)+'\n';});};
 bar(32,'#1E1E22','#F0ECE0','#34343B');bar(120,'#F4F1EA','#1E1E22','#E2DCCD');
 const gy=208;o+=`<rect x="24" y="${gy}" width="${cols*cw+16}" height="${gridH+16}" rx="10" fill="#F4F1EA"/>\n`;
 ORDER.forEach((id,k)=>{const x=32+(k%cols)*cw,y=gy+16+Math.floor(k/cols)*120;o+=g(id,x+32,y,'#1E1E22',2)+`\n<text x="${x+56}" y="${y+76}" text-anchor="middle" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="13" fill="#4A4336">${id}</text>\n`;});
 await saveFile('overview/icons.svg',o+'</svg>\n');}
// ---- font outlines (IM FELL English, OFL) -> paths
const buf=await (await fetch('https://raw.githubusercontent.com/google/fonts/main/ofl/imfellenglish/IMFeENrm28P.ttf')).arrayBuffer();const dv=new DataView(buf);
const tables={};const nt=dv.getUint16(4);for(let k=0;k<nt;k++){const o=12+16*k;tables[String.fromCharCode(...new Uint8Array(buf,o,4))]=dv.getUint32(o+8);}
const upm=dv.getUint16(tables.head+18),locF=dv.getInt16(tables.head+50),nG=dv.getUint16(tables.maxp+4),nH=dv.getUint16(tables.hhea+34);
const adv=g=>dv.getUint16(tables.hmtx+4*Math.min(g,nH-1));
const loca=g=>locF?dv.getUint32(tables.loca+4*g):dv.getUint16(tables.loca+2*g)*2;
function cmapLookup(code){const c=tables.cmap,n=dv.getUint16(c+2);for(let k=0;k<n;k++){const pid=dv.getUint16(c+4+8*k),eid=dv.getUint16(c+6+8*k),off=c+dv.getUint32(c+8+8*k);
  if(pid===3&&eid===1&&dv.getUint16(off)===4){const sc=dv.getUint16(off+6)/2,ends=off+14,starts=ends+2*sc+2,deltas=starts+2*sc,ranges=deltas+2*sc;
   for(let s=0;s<sc;s++){const e=dv.getUint16(ends+2*s),st=dv.getUint16(starts+2*s);if(code>=st&&code<=e){const ro=dv.getUint16(ranges+2*s),de=dv.getInt16(deltas+2*s);if(!ro)return(code+de)&0xFFFF;const gi=dv.getUint16(ranges+2*s+ro+2*(code-st));return gi?(gi+de)&0xFFFF:0;}}}}return 0;}
function glyph(g){const o=tables.glyf+loca(g);if(loca(g+1)===loca(g))return[];const nc=dv.getInt16(o);if(nc<0){let p=o+10,out=[],more=true;while(more){const fl=dv.getUint16(p),gi=dv.getUint16(p+2);p+=4;let dx,dy;if(fl&1){dx=dv.getInt16(p);dy=dv.getInt16(p+2);p+=4;}else{dx=dv.getInt8(p);dy=dv.getInt8(p+1);p+=2;}
  if(fl&8)p+=2;else if(fl&0x40)p+=4;else if(fl&0x80)p+=8;for(const c of glyph(gi))out.push(c.map(q=>({x:q.x+dx,y:q.y+dy,on:q.on})));more=!!(fl&0x20);}return out;}
 const ends=[];for(let k=0;k<nc;k++)ends.push(dv.getUint16(o+10+2*k));const np=ends[nc-1]+1;let p=o+10+2*nc;p+=2+dv.getUint16(p);
 const fl=[];while(fl.length<np){const f=dv.getUint8(p++);fl.push(f);if(f&8){let r=dv.getUint8(p++);while(r--)fl.push(f);}}
 const xs=[],ys=[];let v=0;for(const f of fl){if(f&2){const d=dv.getUint8(p++);v+=f&16?d:-d;}else if(!(f&16)){v+=dv.getInt16(p);p+=2;}xs.push(v);}
 v=0;for(const f of fl){if(f&4){const d=dv.getUint8(p++);v+=f&32?d:-d;}else if(!(f&32)){v+=dv.getInt16(p);p+=2;}ys.push(v);}
 const cs=[];let s=0;for(const e of ends){const c=[];for(let k=s;k<=e;k++)c.push({x:xs[k],y:ys[k],on:!!(fl[k]&1)});cs.push(c);s=e+1;}return cs;}
function contourPath(c,tx){const n=c.length;let st=c.findIndex(q=>q.on);let pts=[];if(st<0){pts=[{x:(c[0].x+c[1].x)/2,y:(c[0].y+c[1].y)/2,on:true}];st=0;}
 for(let k=0;k<n;k++)pts.push(c[(st+k)%n]);const f=q=>tx(q.x,q.y).map(R2).join(' ');let d='M'+f(pts[0]);
 for(let k=1;k<=pts.length;k++){const q=pts[k%pts.length],pr=pts[k-1];if(q.on){if(pr.on)d+='L'+f(q);}else{const nx=pts[(k+1)%pts.length];const end=nx.on?nx:{x:(q.x+nx.x)/2,y:(q.y+nx.y)/2};d+='Q'+f(q)+' '+f(end);if(nx.on)k++;}}return d+'Z';}
function word(text,x0,base,capH,track){const gD=cmapLookup(68),dy=glyph(gD).flat().reduce((m,q)=>Math.max(m,q.y),0),s=capH/dy;let x=x0,d='';
 for(const ch of text){const g=cmapLookup(ch.charCodeAt(0));for(const c of glyph(g))d+=contourPath(c,(gx,gy)=>[x+gx*s,base-gy*s]);x+=adv(g)*s+track;}return{d,w:x-track-x0};}
// ---- mark geometry (64 grid)
const INK='#111111',PAR='#F0ECE0',DARK='#1E1E22';
function markEls(fg,bg){const cx=32,cy=29,Ro=18,Ri=11;const arc=(r,y0)=>`M${cx-r} 56V${cy}A${r} ${r} 0 0 1 ${cx+r} ${cy}V56`;
 const vous=[40,70,90,110,140].map(a=>{const t=a*Math.PI/180;return`M${R2(cx-Ri*Math.cos(t))} ${R2(cy-Ri*Math.sin(t))}L${R2(cx-Ro*Math.cos(t))} ${R2(cy-Ro*Math.sin(t))}`;}).join('')+`M${cx-Ro} 44H${cx-Ri}M${cx+Ri} 40H${cx+Ro}`;
 const steps=[[50.5,55.5,21,43],[45,48.5,23.5,40.5],[40.5,43,26,38],[37,38.8,28.3,35.7]].map(([y0,y1,x0,x1])=>`<path d="M${x0} ${y1}H${x1}L${x1-0.6} ${y0}H${x0+0.6}Z" fill="${bg}"/>`).join('');
 return `<path d="${arc(Ro)}Z" fill="${bg}" stroke="${fg}" stroke-width="2.5" stroke-linejoin="round"/><path d="${arc(Ri)}Z" fill="${fg}"/>${steps}<path d="${vous}" fill="none" stroke="${fg}" stroke-width="1.75" stroke-linecap="round"/><path d="M7 56.5H57" fill="none" stroke="${fg}" stroke-width="2.5" stroke-linecap="round"/>`;}
function faviconEls(fg,bg){return `<path d="M7 27V14.5A9 9 0 0 1 25 14.5V27Z" fill="${fg}"/><path d="M10.2 25.5H21.8L21.2 22H10.8Z" fill="${bg}"/><path d="M12.4 20H19.6L19.1 17.5H12.9Z" fill="${bg}"/><path d="M3.5 27.5H28.5" fill="none" stroke="${fg}" stroke-width="2.5" stroke-linecap="round"/>`;}
const W=word('Delve',78,58,40,1.5);const LW=Math.ceil(78+W.w+14);
for(const[suf,fg,bg]of[['',INK,PAR],['-dark',PAR,DARK]]){
 await saveFile(`brand/mark${suf}.svg`,`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="${bg}"/>${markEls(fg,bg)}</svg>\n`);
 await saveFile(`brand/favicon${suf}.svg`,`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="${bg}"/>${faviconEls(fg,bg)}</svg>\n`);
 await saveFile(`brand/logo${suf}.svg`,`<svg xmlns="http://www.w3.org/2000/svg" width="${LW}" height="72" viewBox="0 0 ${LW} 72"><rect width="${LW}" height="72" fill="${bg}"/><g transform="translate(4 2)">${markEls(fg,bg)}</g><path d="${W.d}" fill="${fg}"/></svg>\n`);}
log('icons',ORDER.length,'logo width',LW,'upm',upm);
