// Decals batch. Run after the toolkit half of tools/furniture.js + terrain helpers (blob/ang/crack not needed).
class DS extends Sheet{shape(pts,o={}){if(o.stroke===NONE)return this.fill(pts,o);return super.shape(pts,{sw:2,...o});}at(fill,stroke,sw){let a=`fill="${fill}" stroke="${stroke}"`;if(stroke!==NONE){if(![1.5,2,2.5].includes(sw))throw'sw '+sw;a+=` stroke-width="${fmt(sw)}" stroke-linecap="round" stroke-linejoin="round"`;}return a;}}
const cha=(p,it)=>{for(let k=0;k<it;k++){const q=[];for(let i=0;i<p.length;i++){const a=p[i],b=p[(i+1)%p.length];q.push([a[0]*0.75+b[0]*0.25,a[1]*0.75+b[1]*0.25],[a[0]*0.25+b[0]*0.75,a[1]*0.25+b[1]*0.75]);}p=q;}return p;};
function blb(s,x,y,r,n=9,j=0.3){const p=[];for(let k=0;k<n;k++){const a=6.2832*k/n+s.pen.u(-.2,.2),rr=r*s.pen.u(1-j,1+j*0.4);p.push([x+rr*Math.cos(a),y+rr*Math.sin(a)]);}return cha(p,2);}
function angl(s,x,y,r){const n=s.pen.u(0,1)<0.5?5:6,p=[];for(let k=0;k<n;k++){const a=6.2832*k/n+s.pen.u(-.3,.3),rr=r*s.pen.u(0.75,1.1);p.push([x+rr*Math.cos(a),y+rr*Math.sin(a)]);}return p;}
function crk(s,p,deg,len,segs,sw,turn=20){const pts=[p];let a=deg;for(let k=0;k<segs;k++){a+=s.pen.u(-turn,turn);const q=pts[pts.length-1];pts.push([q[0]+Math.cos(a*Math.PI/180)*len/segs,q[1]+Math.sin(a*Math.PI/180)*len/segs]);}s.stroke(pts,sw,0.1,3);return pts;}
function taper(s,pts,w0,w1,fill=SHADE,sw=1.5){const n=pts.length,L=[],R=[];for(let i=0;i<n;i++){const a=pts[Math.max(0,i-1)],b=pts[Math.min(n-1,i+1)],tx=b[0]-a[0],ty=b[1]-a[1],l=Math.hypot(tx,ty)||1,w=w0+(w1-w0)*i/(n-1);L.push([pts[i][0]-ty/l*w,pts[i][1]+tx/l*w]);R.unshift([pts[i][0]+ty/l*w,pts[i][1]-tx/l*w]);}s.shape([...L,...R],{fill,sw,amp:0.1,step:2});}
function walk(s,p,deg,len,segs,turn){const pts=[p];let a=deg;for(let k=0;k<segs;k++){a+=s.pen.u(-turn,turn);const q=pts[pts.length-1];pts.push([q[0]+Math.cos(a*Math.PI/180)*len/segs,q[1]+Math.sin(a*Math.PI/180)*len/segs]);}return pts;}
const DC={};
DC['cracks']=()=>{const s=new DS(1,1,301);const m=crk(s,[14,30],24,80,6,2);crk(s,m[2],80,26,3,1.5);crk(s,m[4],-40,20,3,1.5);crk(s,[60,84],-150,26,3,1.5);return s;};
DC['cracks-large']=()=>{const s=new DS(2,2,302);const m=crk(s,[12,40],28,200,11,2.5,16);
 for(const[i,d,l]of[[2,70,52],[5,-55,46],[7,80,58],[9,-40,30]]){const b=crk(s,m[i],Math.atan2(m[i+1][1]-m[i][1],m[i+1][0]-m[i][0])*180/Math.PI+d,l,4,2);crk(s,b[2],Math.atan2(b[3][1]-b[2][1],b[3][0]-b[2][0])*180/Math.PI+(d>0?-40:40),l*0.4,2,1.5);}
 crk(s,[40,168],-20,40,3,1.5);return s;};
DC['puddle']=()=>{const s=new DS(1,1,303);s.shape(blb(s,48,52,30,10,0.28),{fill:SHADE,sw:2,amp:0.3,step:3});
 const a=[];for(let k=0;k<=10;k++){const t=(200+110*k/10)*Math.PI/180;a.push([46+14*Math.cos(t),50+9*Math.sin(t)]);}s.stroke(a,1.5,0.05,2);
 s.shape(blb(s,82,82,5,7,0.2),{fill:SHADE,sw:1.5,amp:0.05,step:1.5});return s;};
DC['puddle-large']=()=>{const s=new DS(2,2,304);s.shape(blb(s,96,100,66,14,0.3),{fill:SHADE,sw:2.5,amp:0.5,step:4});
 for(const[x,y,r]of[[164,58,11],[40,170,8],[172,160,6]])s.shape(blb(s,x,y,r,8,0.25),{fill:SHADE,sw:2,amp:0.1,step:2});
 for(const[cx,cy,rx,ry,a0,a1]of[[90,90,24,14,200,320],[118,122,16,9,20,140]]){const a=[];for(let k=0;k<=12;k++){const t=(a0+(a1-a0)*k/12)*Math.PI/180;a.push([cx+rx*Math.cos(t),cy+ry*Math.sin(t)]);}s.stroke(a,1.5,0.05,2);}return s;};
DC['moss-patch']=()=>{const s=new DS(1,1,305);
 for(const[x,y,w,h,d]of[[10,12,40,34,2],[54,10,36,40,-3],[12,52,34,38,-2],[50,54,40,36,3]])s.shape(rot(rrect(x,y,w,h,3),x+w/2,y+h/2,d),{fill:NONE,sw:2,amp:0.3,step:3});
 s.shape(blb(s,40,46,26,12,0.4),{fill:SHADE,stroke:NONE,sw:2,amp:0.4,step:3});s.shape(blb(s,70,70,14,9,0.35),{fill:SHADE,sw:1.5,amp:0.2,step:2});
 for(const[x,y]of[[20,30],[62,28],[28,74],[78,48],[54,84],[16,50],[44,20]])for(let k=0;k<3;k++)s.dot(x+s.pen.u(-4,4),y+s.pen.u(-4,4),1);return s;};
DC['scorch']=()=>{const s=new DS(1,1,306),u=(a,b)=>s.pen.u(a,b),p=[];
 for(let k=0;k<22;k++){const a=6.2832*k/22,r=(k%2?24:34)*u(0.8,1.1);p.push([50+r*Math.cos(a),50+r*Math.sin(a)]);}s.shape(cha(p,1),{fill:SHADE,stroke:NONE,sw:2,amp:0.3,step:2.5});
 for(let k=0;k<14;k++){const a=u(0,6.28),r=u(4,40);s.dot(50+r*Math.cos(a),50+r*Math.sin(a),u(0.8,1.6));}
 for(const a of[30,140,250]){const r=a*Math.PI/180;s.line([50+36*Math.cos(r),50+36*Math.sin(r)],[50+44*Math.cos(r+0.1),50+44*Math.sin(r+0.1)],1.5,0.05);}return s;};
DC['stain']=()=>{const s=new DS(1,1,307),u=(a,b)=>s.pen.u(a,b);s.shape(blb(s,46,50,22,11,0.4),{fill:SHADE,sw:1.5,amp:0.3,step:2.5});
 for(const[x,y,r]of[[76,34,5],[80,64,3.5],[22,78,4],[30,24,2.5],[68,82,2.6],[86,48,2],[16,46,2]])s.shape(blb(s,x,y,r,7,0.2),{fill:SHADE,stroke:NONE,sw:2,amp:0.05,step:1.3});
 s.shape(band(seg2([64,56],[74,62],3),3),{fill:SHADE,stroke:NONE,amp:0.05,step:1.5});return s;};
DC['debris']=()=>{const s=new DS(1,1,308),u=(a,b)=>s.pen.u(a,b);
 for(const[x,y,d,l]of[[30,30,20,22],[64,60,-35,18],[40,72,70,14]]){const[M]=mk(x,y,d);s.shape(M([[-l/2,0],[-l/4,-2.4],[l/2,-0.6],[l/4,2.2]]),{fill:PAPER,sw:1.5,amp:0.05,step:1.5});}
 for(const[x,y,r,f]of[[62,26,4.5,SHADE],[20,58,3.5,PAPER],[76,80,3,SHADE],[50,48,2.4,SHADE],[82,42,2.6,PAPER],[26,86,2.2,SHADE]])s.shape(angl(s,x,y,r),{fill:f,sw:1.5,amp:0.05,step:1.3});
 for(let k=0;k<6;k++)s.dot(u(12,88),u(12,88),0.9);return s;};
DC['roots']=()=>{const s=new DS(2,2,309);
 const O=[40,70];s.shape([[26,58],[44,54],[58,64],[54,82],[36,86],[24,74]],{fill:INK,sw:2,amp:0.2,step:2});
 crk(s,[58,66],-30,40,3,2);crk(s,[36,86],110,36,3,2);crk(s,[26,60],-120,34,3,2);
 for(const[st,dg,l,w]of[[[52,62],-8,140,7],[[54,76],28,120,6],[[44,84],62,96,5],[[56,70],8,70,4]]){const p=walk(s,st,dg,l,11,16);taper(s,p,w,0.9,SHADE,2);s.stroke(walk(s,p[6],dg+(w>5?-40:40),l*0.28,3,20),1.5,0.05,2.5);}
 return s;};
DC['cobweb-corner']=()=>{const s=new DS(1,1,310),u=(a,b)=>s.pen.u(a,b),O=[6,6];
 const ends=[[92,8],[86,44],[64,72],[36,88],[8,92]].map(p=>[p[0]+u(-1.5,1.5),p[1]+u(-1.5,1.5)]);const rad=ends.map(e=>seg2(O,e,8));
 for(const r of rad)s.stroke(r,1.5,0.1,4);
 for(const t of[3,5,7])for(let i=0;i<rad.length-1;i++){const a=rad[i][t],b=rad[i+1][t];s.line(a,b,1.5,0.05,-L(a,b)*0.14);}return s;};
DC['slime-trail']=()=>{const s=new DS(1,2,311),u=(a,b)=>s.pen.u(a,b),c=[];for(let y=8;y<=192;y+=8)c.push([50+12*Math.sin(y/34)+4*Math.sin(y/11),y]);
 const Lh=[],Rh=[];c.forEach((p,i)=>{const w=9+3*Math.sin(i*0.9);Lh.push([p[0]-w,p[1]]);Rh.unshift([p[0]+w,p[1]]);});
 s.shape([...Lh,...Rh].map(p=>[p[0],Math.min(194,Math.max(6,p[1]))]),{fill:SHADE,sw:1.5,amp:0.4,step:3});
 for(const[x,y,r]of[[28,52,3],[74,108,3.5],[30,150,2.6],[70,30,2.4],[72,172,2.8]])s.shape(blb(s,x,y,r,7,0.2),{fill:SHADE,sw:1.5,amp:0.03,step:1.2});
 s.stroke(c.slice(3,10).map(p=>[p[0]-2,p[1]]),1.5,0.1,4);s.stroke(c.slice(14,20).map(p=>[p[0]+3,p[1]]),1.5,0.1,4);return s;};
DC['footprints']=()=>{const s=new DS(1,2,312);
 for(let k=0;k<6;k++){const side=k%2?1:-1,x=50+side*9+s.pen.u(-1,1),y=176-k*30,d=side*6;const[M]=mk(x,y,d);
  s.shape(M(ell(0,-5,5.2,8)),{fill:SHADE,sw:1.5,amp:0.05,step:1.5});s.shape(M(ell(0,8,4.3,4)),{fill:SHADE,sw:1.5,amp:0.05,step:1.5});}return s;};

const DMETA=[
 ['cracks','Floor Cracks',1,1,['cracks','floor','damage','stone','ruin','decal']],
 ['cracks-large','Large Branching Cracks',2,2,['cracks','large','floor','damage','ruin','decal']],
 ['puddle','Puddle',1,1,['puddle','water','wet','floor','rain','decal']],
 ['puddle-large','Large Puddle',2,2,['puddle','large','water','wet','flood','decal']],
 ['moss-patch','Moss Patch',1,1,['moss','stones','overgrown','ruin','damp','decal']],
 ['scorch','Scorch Mark',1,1,['scorch','burn','fire','spell','soot','decal']],
 ['stain','Dark Stain',1,1,['stain','splatter','blood','dark','floor','decal']],
 ['debris','Scattered Debris',1,1,['debris','splinters','pebbles','mess','ruin','decal']],
 ['roots','Roots Through Floor',2,2,['roots','overgrown','tree','ruin','floor','decal']],
 ['cobweb-corner','Corner Cobweb',1,1,['cobweb','web','corner','spider','dusty','decal']],
 ['slime-trail','Slime Trail',1,2,['slime','trail','ooze','monster','track','decal']],
 ['footprints','Footprints',1,2,['footprints','tracks','trail','boots','snow','decal']]];
const din={},drep={};
for(const[id,,w,h]of DMETA){const s=DC[id]();if(s.W!==w*100||s.H!==h*100)throw id+' size';const svg=s.svg();drep[id]=s.bad.length?s.bad.slice(0,3):0;
 const cols=[...new Set(svg.match(/#[0-9A-Fa-f]{6}/g))].filter(c=>![INK,PAPER,SHADE].includes(c));if(cols.length)drep[id]={cols};
 await saveFile(`decals/${id}.svg`,svg);din[id]=s.els;}
{let x=100;const H=Math.max(...DMETA.map(m=>m[3]));const CH=(H+2)*100,base=(H+1)*100;const Wd=100+DMETA.reduce((a,m)=>a+(m[2]+1)*100,0);
 let grid='';for(let gx=100;gx<Wd;gx+=100)grid+=`M${gx} 0V${CH}`;for(let gy=100;gy<CH;gy+=100)grid+=`M0 ${gy}H${Wd}`;
 let card=`<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}" height="${CH}" viewBox="0 0 ${Wd} ${CH}">\n  <rect width="${Wd}" height="${CH}" fill="#F0ECE0"/>\n  <path d="${grid}" fill="none" stroke="#DDD6C3" stroke-width="1.5"/>\n`;
 for(const[id,,w,h]of DMETA){card+=`  <svg x="${x}" y="${base-h*100}" width="${w*100}" height="${h*100}" viewBox="0 0 ${w*100} ${h*100}">\n`+din[id].map(e=>'  '+e).join('\n')+`\n  </svg>\n  <text x="${x+w*50}" y="${base+36}" text-anchor="middle" font-family="ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="20" fill="#4A4336">${id}</text>\n`;x+=(w+1)*100;}
 await saveFile('overview/decals.svg',card+'</svg>\n');}
const dman=JSON.parse(await readFile('manifest.json')).filter(e=>e.category!=='decals');
const dall=[...dman,...DMETA.map(([id,name,w,h,tags])=>({id,name,category:'decals',w,h,tags,blocks:'none'}))];
const dids=dall.map(e=>e.id);if(new Set(dids).size!==dids.length)throw 'duplicate id '+dids.filter((x,i)=>dids.indexOf(x)!==i);
await saveFile('manifest.json','[\n'+dall.map(e=>'  '+JSON.stringify(e).replace(/,"/g,', "').replace(/":/g,'": ')).join(',\n')+'\n]\n');
log(JSON.stringify(drep));
