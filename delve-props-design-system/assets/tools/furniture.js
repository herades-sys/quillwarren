// Quillwarren props — furniture batch generator (JS port of tools/ink.py). Run with run-style helpers: saveFile, log.
const INK='#000000',PAPER='#FFFFFF',SHADE='#999999',NONE='none',OUT=4,DET=2,TEX=1.5;
const fmt=v=>{let s=v.toFixed(1);if(s.endsWith('.0'))s=s.slice(0,-2);if(s==='-0')s='0';return s;};
function mulberry(a){return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const L=(a,b)=>Math.hypot(b[0]-a[0],b[1]-a[1]);
function resample(pts,step,closed){const seg=[];for(let i=0;i<pts.length-(closed?0:1);i++)seg.push([pts[i],pts[(i+1)%pts.length]]);
 const total=seg.reduce((s,[a,b])=>s+L(a,b),0);const n=Math.max(closed?6:2,Math.round(total/step));const d=total/n;const out=[];let acc=0,i=0;
 for(let k=0;k<n+(closed?0:1);k++){const t=k*d;while(i<seg.length-1&&acc+L(...seg[i])<t-1e-9){acc+=L(...seg[i]);i++;}const[a,b]=seg[i];const l=L(a,b)||1e-9;const u=Math.min(1,Math.max(0,(t-acc)/l));out.push([a[0]+(b[0]-a[0])*u,a[1]+(b[1]-a[1])*u]);}
 return out;}
class Pen{constructor(seed){this.r=mulberry(seed*9973+17);}u(a,b){return a+(b-a)*this.r();}
 noise(len,amp,closed,wl){const c=[];for(let i=0;i<3;i++){const lam=this.u(...wl)*(i===0?2.2:1/i);const f=closed?Math.max(1,Math.round(len/lam))/len:1/lam;c.push([(i===0?1:0.35/i)*this.u(0.8,1),f,this.u(0,6.2832)]);}
  const pk=c.reduce((s,x)=>s+x[0],0);c.forEach(x=>x[0]*=amp/pk);return s=>c.reduce((a,[A,f,p])=>a+A*Math.sin(6.2832*f*s+p),0);}
 wobble(pts,closed,amp,step,wl){const b=resample(pts,step,closed);const n=b.length;const s=[0];let acc=0;for(let i=1;i<n;i++){acc+=L(b[i-1],b[i]);s.push(acc);}
  const total=acc+(closed?L(b[n-1],b[0]):0);const nz=this.noise(total,amp,closed,wl);
  return b.map((p,i)=>{const a=closed?b[(i-1+n)%n]:b[Math.max(0,i-1)],c=closed?b[(i+1)%n]:b[Math.min(n-1,i+1)];const tx=c[0]-a[0],ty=c[1]-a[1],l=Math.hypot(tx,ty)||1,o=nz(s[i]);return[p[0]-ty/l*o,p[1]+tx/l*o];});}}
function bez(pts,closed){const n=pts.length;const P=i=>closed?pts[((i%n)+n)%n]:pts[Math.max(0,Math.min(n-1,i))];
 const T=i=>{if(!closed&&i===0)return[P(1)[0]-P(0)[0],P(1)[1]-P(0)[1]];if(!closed&&i===n-1)return[P(n-1)[0]-P(n-2)[0],P(n-1)[1]-P(n-2)[1]];const a=P(i-1),b=P(i+1);return[(b[0]-a[0])/2,(b[1]-a[1])/2];};
 let d=`M${fmt(pts[0][0])} ${fmt(pts[0][1])}`;for(let i=0;i<(closed?n:n-1);i++){const p0=P(i),p1=P(i+1),j=closed?(i+1)%n:i+1,to=T(i),ti=T(j);
  d+=`C${fmt(p0[0]+to[0]/3)} ${fmt(p0[1]+to[1]/3)} ${fmt(p1[0]-ti[0]/3)} ${fmt(p1[1]-ti[1]/3)} ${fmt(p1[0])} ${fmt(p1[1])}`;}return d+(closed?'Z':'');}
function rrect(x,y,w,h,r=0,cn=5){r=Math.min(r,w/2,h/2);if(r<=0.01)return[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];const p=[];
 for(const[cx,cy,a0]of[[x+w-r,y+r,-Math.PI/2],[x+w-r,y+h-r,0],[x+r,y+h-r,Math.PI/2],[x+r,y+r,Math.PI]])for(let k=0;k<=cn;k++){const a=a0+Math.PI/2*k/cn;p.push([cx+r*Math.cos(a),cy+r*Math.sin(a)]);}return p;}
const circ=(cx,cy,r,n)=>{n=n||Math.max(12,Math.floor(Math.PI*r));return[...Array(n)].map((_,k)=>[cx+r*Math.cos(6.2832*k/n),cy+r*Math.sin(6.2832*k/n)]);};
const ell=(cx,cy,rx,ry)=>{const n=Math.max(16,Math.floor(Math.PI*(rx+ry)/2));return[...Array(n)].map((_,k)=>[cx+rx*Math.cos(6.2832*k/n),cy+ry*Math.sin(6.2832*k/n)]);};
const rot=(pts,cx,cy,deg)=>{const a=deg*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return pts.map(([x,y])=>[cx+(x-cx)*c-(y-cy)*s,cy+(x-cx)*s+(y-cy)*c]);};
function band(center,half,capn=6){const n=center.length;const N=center.map((_,i)=>{const a=center[Math.max(0,i-1)],b=center[Math.min(n-1,i+1)],tx=b[0]-a[0],ty=b[1]-a[1],l=Math.hypot(tx,ty)||1;return[-ty/l,tx/l];});
 const left=center.map((p,i)=>[p[0]+N[i][0]*half,p[1]+N[i][1]*half]),right=center.map((p,i)=>[p[0]-N[i][0]*half,p[1]-N[i][1]*half]);const pts=[...left];
 let e=center[n-1],base=Math.atan2(N[n-1][1],N[n-1][0]);for(let k=1;k<capn;k++){const t=base-Math.PI*k/capn;pts.push([e[0]+half*Math.cos(t),e[1]+half*Math.sin(t)]);}
 pts.push(...right.slice().reverse());e=center[0];base=Math.atan2(N[0][1],N[0][0]);for(let k=1;k<capn;k++){const t=base+Math.PI-Math.PI*k/capn;pts.push([e[0]+half*Math.cos(t),e[1]+half*Math.sin(t)]);}return pts;}
const seg2=(a,b,n=8)=>[...Array(n+1)].map((_,k)=>[a[0]+(b[0]-a[0])*k/n,a[1]+(b[1]-a[1])*k/n]);
function clipLine(p0,p1,poly){const hits=[];const[x1,y1]=p0,[x2,y2]=p1;for(let i=0;i<poly.length;i++){const[x3,y3]=poly[i],[x4,y4]=poly[(i+1)%poly.length];const den=(x1-x2)*(y3-y4)-(y1-y2)*(x3-x4);if(Math.abs(den)<1e-12)continue;
 const t=((x1-x3)*(y3-y4)-(y1-y3)*(x3-x4))/den,u=-((x1-x2)*(y1-y3)-(y1-y2)*(x1-x3))/den;if(t>=0&&t<=1&&u>=0&&u<=1)hits.push(t);}hits.sort((a,b)=>a-b);if(hits.length<2)return null;
 const lp=u=>[p0[0]+(p1[0]-p0[0])*u,p0[1]+(p1[1]-p0[1])*u];return[lp(hits[0]),lp(hits[hits.length-1])];}
class Sheet{constructor(w,h,seed){this.W=w*100;this.H=h*100;this.pen=new Pen(seed);this.els=[];this.bad=[];}
 track(pts,sw){const hw=sw/2,m=4-0.05;for(const p of pts)if(p[0]-hw<m||p[1]-hw<m||p[0]+hw>this.W-m||p[1]+hw>this.H-m){this.bad.push(p.map(v=>v.toFixed(1)).join(','));return;}}
 at(fill,stroke,sw){let a=`fill="${fill}" stroke="${stroke}"`;if(stroke!==NONE){if(![4,2,1.5].includes(sw))throw'sw '+sw;a+=` stroke-width="${fmt(sw)}" stroke-linecap="round" stroke-linejoin="round"`;}return a;}
 path(d,fill,stroke,sw,pts){this.track(pts,stroke===NONE?0:sw);this.els.push(`<path d="${d}" ${this.at(fill,stroke,sw)}/>`);}
 shape(pts,o={}){const{fill=PAPER,sw=OUT,amp=0.6,step=5}=o;const wp=this.pen.wobble(pts,true,amp,step,[22,60]);this.path(bez(wp,true),fill,INK,sw,wp);return wp;}
 fill(pts,o={}){const{fill=PAPER,amp=0.6,step=5}=o;const wp=this.pen.wobble(pts,true,amp,step,[22,60]);this.path(bez(wp,true),fill,NONE,0,wp);return wp;}
 fo(pts,o={}){const{fill=PAPER,sw=OUT,amp=0.6,step=5}=o;const wp=this.pen.wobble(pts,true,amp,step,[22,60]);const d=bez(wp,true);this.path(d,fill,NONE,0,wp);return[wp,()=>this.path(d,NONE,INK,sw,wp)];}
 stroke(pts,sw=DET,amp=0.35,step=5){const wp=this.pen.wobble(pts,false,amp,step,[18,45]);this.path(bez(wp,false),NONE,INK,sw,wp);return wp;}
 line(p0,p1,sw=DET,amp=0.35,bow=0,step=6){const l=L(p0,p1),n=Math.max(2,Math.floor(l/step)),nx=-(p1[1]-p0[1])/(l||1),ny=(p1[0]-p0[0])/(l||1),pts=[];
  for(let k=0;k<=n;k++){const u=k/n,b=bow*Math.sin(Math.PI*u);pts.push([p0[0]+(p1[0]-p0[0])*u+nx*b,p0[1]+(p1[1]-p0[1])*u+ny*b]);}return this.stroke(pts,sw,amp,step);}
 seam(p0,p1,poly,sw=DET){const s=clipLine(p0,p1,poly);if(s)this.line(s[0],s[1],sw,0.35,this.pen.u(-0.5,0.5));}
 grain(a,b){this.line(a,b,TEX,0.22,this.pen.u(-1.1,1.1));}
 dot(cx,cy,r){this.track([[cx-r,cy-r],[cx+r,cy+r]],0);this.els.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="${INK}" stroke="none"/>`);}
 poly(pts,fill){this.track(pts,0);this.els.push(`<polygon points="${pts.map(p=>fmt(p[0])+','+fmt(p[1])).join(' ')}" fill="${fill}" stroke="none"/>`);}
 svg(){return`<svg xmlns="http://www.w3.org/2000/svg" width="${this.W}" height="${this.H}" viewBox="0 0 ${this.W} ${this.H}">\n`+this.els.map(e=>'  '+e).join('\n')+'\n</svg>\n';}}

// chair, local frame: seat front toward +y (south), back rail toward -y. deg turns the facing.
function chair(s,cx,cy,deg,sc=1){const P=pts=>rot(pts.map(([x,y])=>[cx+x*sc,cy+y*sc]),cx,cy,deg);
 s.shape(P(rrect(-18,-17,36,34,6)),{amp:0.3,step:3});
 for(const y of[3,-7]){const[a,b]=P([[-17.5,y],[17.5,y]]);s.line(a,b,TEX,0.1);}
 const rail=[];for(let x=-21;x<=21;x+=3)rail.push([x,-16.5-2.2*(1-(x/21)**2)]);
 s.shape(P(band(rail,3.8)),{fill:SHADE,amp:0.15,step:2.5});}
function bed(s,{x,y,w,h,head=14,side=7,foot=8,pillows,foldY}){
 const[frame,out]=s.fo(rrect(x,y,w,h,5),{fill:SHADE});
 const mx=x+side,my=y+head,mw=w-2*side,mh=h-head-foot;
 s.shape(rrect(mx,my,mw,mh,5),{sw:DET,amp:0.35});
 for(const p of pillows){s.shape(rrect(...p,8),{sw:DET,amp:0.3,step:3});s.line([p[0]+8,p[1]+p[3]*0.45],[p[0]+p[2]*0.42,p[1]+p[3]*0.38],TEX,0.15,-0.8);}
 s.shape(rrect(mx-1,foldY+6,mw+2,my+mh-foldY-6,5),{fill:SHADE,sw:DET,amp:0.35});
 s.shape(rrect(mx-1,foldY,mw+2,13,3),{sw:DET,amp:0.3});
 return out;}

const D={};
D['table-square']=()=>{const s=new Sheet(1,1,11),u=(a,b)=>s.pen.u(a,b);
 const[top,out]=s.fo(rrect(16,16,68,68,3),{amp:0.5});
 for(const x of[33.5,51,67.5])s.seam([x+u(-.4,.4),5],[x+u(-.4,.4),95],top);
 for(const[x,a,b]of[[24,26,42],[26,60,76],[42,44,62],[59,24,40],[60,62,78],[76,40,56]])s.grain([x,a],[x+u(-.6,.6),b]);
 out();return s;};
D['table-rect']=()=>{const s=new Sheet(2,1,12),u=(a,b)=>s.pen.u(a,b);
 const[top,out]=s.fo(rrect(12,14,176,72,3));
 for(const y of[32,50.5,68.5])s.seam([4,y+u(-.4,.4)],[196,y+u(-.4,.4)],top);
 for(const[a,b,y]of[[26,46,22],[92,112,24],[150,170,21],[50,70,41],[124,146,42],[28,48,60],[98,118,58],[158,178,61],[62,84,77],[134,152,78]])s.grain([a,y],[b,y+u(-.6,.6)]);
 out();return s;};
D['table-long']=()=>{const s=new Sheet(3,1,13),u=(a,b)=>s.pen.u(a,b);
 const[top,out]=s.fo(rrect(10,14,280,72,3));
 for(const y of[32,50,68.5])s.seam([4,y+u(-.4,.4)],[296,y+u(-.4,.4)],top);
 for(const[a,b,y]of[[24,44,22],[82,104,24],[146,166,21],[204,224,24],[252,274,22],[42,62,78],[110,130,76],[178,200,79],[236,256,77]])s.grain([a,y],[b,y+u(-.6,.6)]);
 s.shape(rrect(26,37,248,26,1.5),{fill:SHADE,sw:DET,amp:0.35});
 s.line([44,45],[118,46],TEX,0.2,0.8);s.line([168,55],[246,54],TEX,0.2,-0.8);
 out();return s;};
D['table-round-four']=()=>{const s=new Sheet(2,2,14),u=(a,b)=>s.pen.u(a,b);const C=100,R=54;
 chair(s,104,160,185);chair(s,97,40,-4);chair(s,160,103,94);chair(s,40,97,-95);
 const[top,out]=s.fo(circ(C,C,R),{amp:0.6});
 for(const x of[C-36,C-18,C+0.5,C+18.5,C+36])s.seam([x+u(-.4,.4),20],[x+u(-.4,.4),180],top);
 for(const[gx,a,b]of[[C-45,92,108],[C-27,70,86],[C-28,116,132],[C-9,58,72],[C-9,98,110],[C+9,118,134],[C+27,72,88],[C+28,112,126],[C+45,94,110]])s.grain([gx,a],[gx+u(-.7,.7),b]);
 out();return s;};
D['chair']=()=>{const s=new Sheet(1,1,15);chair(s,50,53,3,1.2);return s;};
D['bench']=()=>{const s=new Sheet(2,1,16),u=(a,b)=>s.pen.u(a,b),R=p=>rot(p,100,50,1.5);
 const[seat,out]=s.fo(R(rrect(12,33,176,34,5)));
 s.seam(...R([[4,49.8],[196,50.2]]),seat);
 for(const[a,b,y]of[[34,56,41],[104,124,42],[150,170,40],[60,82,58],[124,146,59]]){const[p,q]=R([[a,y],[b,y+u(-.5,.5)]]);s.grain(p,q);}
 for(const x of[22,178])for(const y of[41,58]){const[p]=R([[x,y]]);s.dot(p[0],p[1],1.4);}
 out();return s;};
D['bed-single']=()=>{const s=new Sheet(1,2,17);
 const out=bed(s,{x:12,y:10,w:76,h:180,pillows:[[26,30,48,24]],foldY:92});
 s.line([36,118],[34,150],TEX,0.2,1);s.line([62,142],[65,172],TEX,0.2,-1);
 out();return s;};
D['bed-double']=()=>{const s=new Sheet(2,2,18);
 const out=bed(s,{x:14,y:16,w:172,h:172,head:14,side:8,foot:8,pillows:[[32,38,62,26],[106,38,62,26]],foldY:98});
 s.line([48,126],[46,160],TEX,0.2,1);s.line([104,140],[108,172],TEX,0.2,-1);s.line([150,120],[152,146],TEX,0.2,0.8);
 out();for(const[px,py]of[[8,10],[174,10],[8,172],[174,172]])s.shape(rrect(px,py,18,18,4),{amp:0.2,step:3});return s;};
D['bunk-bed']=()=>{const s=new Sheet(1,2,19);
 for(const y of[114,128,142,156])s.shape(band(seg2([79,y],[91.5,y+1],4),2.2),{sw:DET,amp:0.1,step:2});
 for(const x of[79,91.5])s.shape(band(seg2([x,104],[x+0.5,168],10),2.4),{fill:SHADE,sw:DET,amp:0.12,step:2.5});
 const out=bed(s,{x:12,y:12,w:60,h:176,head:12,side:6,foot:8,pillows:[[22,30,40,20]],foldY:96});
 s.line([34,122],[33,156],TEX,0.2,1);
 s.shape(band(seg2([16,40],[15.5,150],12),3.2),{sw:DET,amp:0.15,step:3});
 out();for(const[px,py]of[[7,7],[63,7],[7,179],[63,179]])s.shape(rrect(px,py,14,14,3),{amp:0.2,step:3});return s;};
D['bedroll']=()=>{const s=new Sheet(1,2,20),R=p=>rot(p,50,116,2),Q=p=>rot(p,50,28,-6);
 const[mat,out]=s.fo(R(rrect(25,50,50,134,10)));
 s.line(...R([[38,62],[38,90]]),TEX,0.2,0.8);s.line(...R([[60,70],[61,94]]),TEX,0.2,-0.6);
 s.shape(R([[25,100],[56,100],[75,118],[75,174],[74,180],[70,184],[30,184],[26,180],[25,174]]),{fill:SHADE,sw:DET,amp:0.35,step:4});
 s.shape(R([[56,100],[75,118],[54,121]]),{sw:DET,amp:0.2,step:3});
 s.line(...R([[36,130],[35,168]]),TEX,0.2,1);s.line(...R([[60,140],[62,174]]),TEX,0.2,-0.8);
 out();
 s.shape(Q(rrect(28,11,44,34,9)),{amp:0.3,step:3});
 s.shape(Q(rrect(31,13,38,17,5)),{fill:SHADE,sw:DET,amp:0.2,step:3});
 s.shape(Q(band(seg2([50,14],[50,40],4),2.6)),{sw:DET,amp:0.1,step:2});
 s.poly(Q([[48.6,30],[51.4,30],[51.4,33],[48.6,33]]),INK);
 return s;};
D['wardrobe']=()=>{const s=new Sheet(2,1,21),u=(a,b)=>s.pen.u(a,b);
 const[body,out]=s.fo(rrect(10,8,180,64,3));
 s.shape(rrect(19,15,162,38,2),{fill:SHADE,sw:DET,amp:0.35});
 for(const[a,b,y]of[[34,56,24],[108,130,27],[70,90,43],[146,166,40]])s.grain([a,y],[b,y+u(-.5,.5)]);
 s.shape(rrect(15,59,170,11,2),{fill:SHADE,sw:DET,amp:0.3});
 s.line([100,59.5],[100.3,69.5],DET,0.1);
 s.dot(94,64.5,1.5);s.dot(106,64.5,1.5);
 out();return s;};
D['bookshelf']=()=>{const s=new Sheet(2,1,22),u=(a,b)=>s.pen.u(a,b);
 const[box,out]=s.fo(rrect(8,8,184,56,3));
 s.shape(rrect(15,14,170,42,1.5),{fill:SHADE,sw:DET,amp:0.3});
 [[17,67],[73,127],[133,183]].forEach(([x0,x1],bi)=>{let x=x0+0.5,i=0;const gapAt=[3,5,2][bi];
  while(true){const w=u(5.5,9);if(x+w>x1)break;
   if(i===gapAt){s.shape(rot(rrect(x+3,22,6.5,30,1),x+3,52,-18),{sw:DET,amp:0.1,step:2});x+=12;i++;continue;}
   const d=u(27,35),yb=53-u(0,1.2);s.shape(rrect(x,yb-d,w,d,1),{sw:DET,amp:0.1,step:2});x+=w+u(0,0.6);i++;}});
 for(const x of[70,130])s.shape(band(seg2([x,14.5],[x,55.5],6),2.3),{sw:DET,amp:0.1,step:2});
 out();return s;};
D['desk']=()=>{const s=new Sheet(2,1,23),u=(a,b)=>s.pen.u(a,b);
 const[top,out]=s.fo(rrect(12,12,176,70,3));
 for(const y of[29.5,47,64.5])s.seam([4,y+u(-.4,.4)],[196,y+u(-.4,.4)],top);
 for(const[a,b,y]of[[20,40,21],[24,44,56],[30,50,73],[146,166,21],[160,180,74]])s.grain([a,y],[b,y+u(-.5,.5)]);
 s.shape(rrect(56,20,80,56,2),{fill:SHADE,sw:DET,amp:0.35});
 const B=p=>rot(p,96,48,-3);
 s.shape(B([[66,29],[80,27.5],[96,31],[96,69],[80,66],[66,67.5]]),{sw:DET,amp:0.25,step:3});
 s.shape(B([[96,31],[112,27.5],[126,29],[126,67.5],[112,66],[96,69]]),{sw:DET,amp:0.25,step:3});
 s.shape(circ(164,30,7.5),{fill:SHADE,sw:DET,amp:0.15,step:2});
 const q0=[146,72],q1=[182,42],dx=q1[0]-q0[0],dy=q1[1]-q0[1],l=Math.hypot(dx,dy),nx=-dy/l,ny=dx/l,side=[],other=[];
 for(let k=0;k<=12;k++){const t=0.28+0.72*k/12,w=5.5*Math.pow(Math.sin(Math.PI*Math.min(1,(t-0.28)/0.72)),0.6);const c=[q0[0]+dx*t,q0[1]+dy*t];side.push([c[0]+nx*w,c[1]+ny*w]);other.unshift([c[0]-nx*w*0.7,c[1]-ny*w*0.7]);}
 s.shape([...side,...other],{sw:DET,amp:0.15,step:2.5});
 s.line(q0,[q0[0]+dx*0.97,q0[1]+dy*0.97],DET,0.1);
 out();return s;};
D['throne']=()=>{const s=new Sheet(2,2,24);
 s.shape(rrect(46,140,108,48,3));
 s.line([98,166],[112,172],TEX,0.2,0.6);
 const[dais,out]=s.fo(rrect(12,10,176,148,4));
 s.seam([60,4],[60.5,196],dais);s.seam([140,4],[139.5,196],dais);s.seam([4,86],[60,86.5],dais);s.seam([140,94],[196,93.5],dais);
 s.line([26,124],[40,132],TEX,0.2,0.8);s.line([160,40],[170,54],TEX,0.2,-0.6);s.line([92,130],[108,134],TEX,0.2,0.5);
 const crest=[];for(let k=0;k<=16;k++){const t=k/16;crest.push([54+92*t,30-14*Math.sin(Math.PI*t)**0.8]);}
 s.shape([...crest,[146,108],[145,112],[142,115],[138,116],[62,116],[58,115],[55,112],[54,108]],{fill:SHADE,amp:0.4,step:4});
 const inner=[];for(let k=0;k<=12;k++){const t=k/12;inner.push([64+72*t,36-10*Math.sin(Math.PI*t)**0.8]);}
 s.stroke(inner,DET,0.2,4);
 s.shape(rrect(68,46,64,64,6),{sw:DET,amp:0.3});
 s.line([80,66],[94,70],TEX,0.15,-0.6);s.line([104,88],[120,86],TEX,0.15,0.6);
 for(const x of[61,139])s.shape(circ(x,106,6),{sw:DET,amp:0.12,step:2});
 out();return s;};
D['bar-counter']=()=>{const s=new Sheet(3,1,25),u=(a,b)=>s.pen.u(a,b);
 const[top,out]=s.fo(rrect(8,34,284,46,4));
 for(const y of[49.5,65])s.seam([4,y+u(-.4,.4)],[296,y+u(-.4,.4)],top);
 s.seam([262,20],[262.5,95],top);
 for(const[a,b,y]of[[20,40,42],[120,142,41],[196,216,43],[36,58,72],[130,150,58],[150,170,73],[240,258,72],[272,286,57]])s.grain([a,y],[b,y+u(-.5,.5)]);
 for(const[cx,cy,ang]of[[58,56,-20],[92,63,30],[176,55,160],[224,60,-5]]){
  const H=p=>rot(p.map(([x,y])=>[cx+x,cy+y]),cx,cy,ang);
  s.shape(H(rrect(5,-3.8,10,7.6,3)),{sw:DET,amp:0.08,step:2});
  s.poly(H([[9,-1.3],[12,-1.3],[12,1.3],[9,1.3]]),INK);
  s.shape(circ(cx,cy,8.5),{fill:SHADE,sw:DET,amp:0.12,step:2});}
 out();return s;};
D['fireplace']=()=>{const s=new Sheet(2,1,26);
 const[hearth,hout]=s.fo(rrect(36,56,128,36,3),{fill:SHADE});
 s.seam([78,70],[78.5,99],hearth);s.seam([122,70],[121.5,99],hearth);s.line([134,78],[148,86],TEX,0.2,0.5);
 hout();
 const mouth=[[50,72],[64,20],[136,20],[150,72]],floor=[[61,72],[72,28],[128,28],[139,72]];
 s.fill(mouth,{fill:SHADE,amp:0.2,step:4});
 s.fill(floor,{fill:PAPER,amp:0.2,step:4});
 s.stroke([[62,70],[72,28],[128,28],[138,70]],DET,0.2,4);
 s.line([54,70],[146,70],DET,0.2);
 s.shape(ell(100,50,30,15),{fill:SHADE,sw:DET,amp:0.9,step:3});
 s.shape(band(seg2([80,55],[104,51],6),4.5),{amp:0.2,step:3});
 s.shape(band(seg2([100,41],[121,46],6),4.5),{amp:0.2,step:3});
 const[sp,sout]=s.fo([[10,8],[190,8],[190,70],[150,70],[136,20],[64,20],[50,70],[10,70]],{amp:0.4,step:4});
 s.line([32,8.5],[32.5,69.5],DET,0.3);s.line([168,8.5],[167.5,69.5],DET,0.3);
 s.line([10.5,38],[32,38.5],DET,0.3);s.line([168,36],[189.5,36.5],DET,0.3);
 s.line([32.5,44],[52,44.5],DET,0.3);s.line([148,46],[167.5,46.5],DET,0.3);
 s.line([84,8.5],[84.5,19.5],DET,0.2);s.line([118,8.5],[117.5,19.5],DET,0.2);
 s.line([18,50],[25,60],TEX,0.2,0.5);s.line([174,18],[184,24],TEX,0.2,-0.5);
 sout();return s;};

const META=[
 ['table-square','Small Square Table',1,1,['table','square','furniture','wood','tavern','dining'],'movement'],
 ['table-rect','Rectangular Table',2,1,['table','rectangular','planks','furniture','wood','dining','tavern'],'movement'],
 ['table-long','Long Feast Table',3,1,['table','long','feast','runner','cloth','furniture','hall','dining'],'movement'],
 ['table-round-four','Round Table with Four Chairs',2,2,['table','round','chair','furniture','wood','tavern','dining'],'movement'],
 ['chair','Wooden Chair',1,1,['chair','seat','furniture','wood','tavern','dining'],'movement'],
 ['bench','Wooden Bench',2,1,['bench','seat','furniture','wood','tavern','hall'],'movement'],
 ['bed-single','Single Bed',1,2,['bed','single','pillow','blanket','furniture','bedroom','inn'],'movement'],
 ['bed-double','Double Bed with Canopy Posts',2,2,['bed','double','canopy','pillow','furniture','bedroom','noble'],'movement'],
 ['bunk-bed','Bunk Bed',1,2,['bed','bunk','ladder','furniture','wood','barracks','dormitory'],'sight'],
 ['bedroll','Bedroll with Pack',1,2,['bedroll','pack','camp','sleep','travel','canvas'],'none'],
 ['wardrobe','Wardrobe',2,1,['wardrobe','cupboard','storage','furniture','wood','bedroom'],'sight'],
 ['bookshelf','Bookshelf',2,1,['bookshelf','books','library','study','furniture','wood'],'sight'],
 ['desk','Writing Desk',2,1,['desk','book','quill','ink','study','furniture','wood'],'movement'],
 ['throne','Throne on Dais',2,2,['throne','dais','royal','seat','hall','stone','wood'],'movement'],
 ['bar-counter','Bar Counter with Tankards',3,1,['bar','counter','tankard','ale','tavern','wood'],'movement'],
 ['fireplace','Stone Fireplace',2,1,['fireplace','hearth','fire','stone','logs','tavern','wall'],'sight']];

const report={},inner={};
for(const[id,,w,h]of META){const s=D[id]();if(s.W!==w*100||s.H!==h*100)throw id+' size';
 const svg=s.svg();await saveFile(`furniture/${id}.svg`,svg);inner[id]=s.els;
 const cols=[...new Set(svg.match(/#[0-9A-Fa-f]{6}/g))].filter(c=>![INK,PAPER,SHADE].includes(c));
 const widths=[...new Set(svg.match(/stroke-width="([^"]+)"/g))].filter(x=>!/"(4|2|1\.5)"/.test(x));
 report[id]={bad:s.bad.slice(0,3),cols,widths};}
let x=100;const W=100+META.reduce((a,m)=>a+(m[2]+1)*100,0);let grid='';for(let gx=100;gx<W;gx+=100)grid+=`M${gx} 0V400`;for(const gy of[100,200,300])grid+=`M0 ${gy}H${W}`;
let card=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="400" viewBox="0 0 ${W} 400">\n  <rect width="${W}" height="400" fill="#F0ECE0"/>\n  <path d="${grid}" fill="none" stroke="#DDD6C3" stroke-width="1.5"/>\n`;
for(const[id,,w,h]of META){card+=`  <svg x="${x}" y="${300-h*100}" width="${w*100}" height="${h*100}" viewBox="0 0 ${w*100} ${h*100}">\n`+inner[id].map(e=>'  '+e).join('\n')+`\n  </svg>\n  <text x="${x+w*50}" y="336" text-anchor="middle" font-family="ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="20" fill="#4A4336">${id}</text>\n`;x+=(w+1)*100;}
await saveFile('overview/furniture.svg',card+'</svg>\n');
log(JSON.stringify(report));
