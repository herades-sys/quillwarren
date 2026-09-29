// Storage + treasure batch. Run after the toolkit half of tools/furniture.js (everything before `const D={};`).
const mk=(cx,cy,deg,ox=0,oy=0)=>{const M=pts=>rot(pts.map(([x,y])=>[x-ox+cx,y-oy+cy]),cx,cy,deg);return[M,p=>M([p])[0]];};
function chestC(s,cx,cy,deg){const[M,M1]=mk(cx,cy,deg,50,50),u=(a,b)=>s.pen.u(a,b);
 for(const sx of[-1,1]){const ex=sx<0?16:84,o=ex+sx*7;
  s.shape(M([[ex-sx*2,42.5],[o,43.5],[o,56.5],[ex-sx*2,57.5]]),{fill:SHADE,sw:DET,amp:0.1,step:2.5});
  const gx=ex+sx*3.8;s.poly(M([[gx-1,46],[gx+1,46],[gx+1,54],[gx-1,54]]),INK);}
 const[body,out]=s.fo(M(rrect(16,29,68,42,3)),{amp:0.6,step:4});
 for(const y of[43,57])s.seam(M1([5,y]),M1([95,y]),body);
 for(const[a,b,y]of[[36,50,35.5],[52,63,40],[37,47,49.5],[55,64,53.5],[40,56,64]])s.grain(M1([a,y]),M1([b,y+u(-.6,.6)]));
 for(const bx of[24,69]){s.shape(M([[bx,25],[bx+7,25],[bx+7,73],[bx,73]]),{fill:SHADE,sw:DET,amp:0.25,step:4});for(const ry of[28.5,50,68]){const p=M1([bx+3.5,ry]);s.dot(p[0],p[1],1.5);}}
 s.shape(M([[46.5,56],[53.5,56],[53.5,66],[46.5,66]]),{fill:SHADE,sw:DET,amp:0.2,step:4});
 out();
 s.shape(M(rrect(42.5,64,15,13.5,2.5)),{fill:SHADE,sw:DET,amp:0.3,step:3});
 const k=M1([50,69]);s.dot(k[0],k[1],2.1);s.poly(M([[48.9,70],[51.1,70],[51.9,74.2],[48.1,74.2]]),INK);}
function barrelC(s,cx,cy,k=1,deg=0){const[M,M1]=mk(cx,cy,deg),u=(a,b)=>s.pen.u(a,b),th=deg*Math.PI/180;
 s.shape(circ(cx,cy,41*k),{fill:SHADE,amp:0.6});
 s.shape(circ(cx,cy,36.9*k),{fill:NONE,sw:TEX,amp:0.2});
 s.shape(circ(cx,cy,33.6*k),{sw:DET,amp:0.35});
 const n=Math.round(15*k);for(let i=0;i<n;i++){const a=6.2832*(i+u(-.12,.12))/n+0.2+th;s.line([cx+27.5*k*Math.cos(a),cy+27.5*k*Math.sin(a)],[cx+34*k*Math.cos(a),cy+34*k*Math.sin(a)],TEX,0.15);}
 const lid=s.shape(circ(cx,cy,27.5*k),{sw:DET,amp:0.45});
 for(const x of[-9.5*k,9.5*k]){const sg=clipLine(M1([x,-40]),M1([x,40]),lid);if(sg)s.line(sg[0],sg[1],DET,0.35);}
 for(const[x,a,b]of[[-17,-12,6],[-3.5,-20,-4],[3.5,5,19],[16,-9,11]])s.line(M1([x*k,a*k]),M1([(x+u(-1,1))*k,b*k]),TEX,0.5,u(-1.2,1.2));
 const bh=M1([1.5*k,-5.5*k]);s.dot(bh[0],bh[1],2.8);
 for(const a of[0.9+th,0.9+th+Math.PI])s.dot(cx+38.9*k*Math.cos(a),cy+38.9*k*Math.sin(a),1.1);}
function sideBarrel(s,cx,cy,deg){const[M,M1]=mk(cx,cy,deg),h=x=>28-5*(x/44)**2,top=[],bot=[];
 for(let x=-44;x<=44;x+=4){top.push([x,-h(x)]);bot.unshift([x,h(x)]);}
 const[body,out]=s.fo(M([...top,...bot]),{amp:0.5,step:4});
 for(const f of[-0.45,0.02,0.47]){const pts=[];for(let x=-42;x<=42;x+=6)pts.push([x,f*h(x)]);s.stroke(M(pts),TEX,0.2,6);}
 for(const a of[-34,-14,14,34]){const x0=a-3,x1=a+3;s.shape(M([[x0,-h(x0)-0.5],[x1,-h(x1)-0.5],[x1,h(x1)+0.5],[x0,h(x0)+0.5]]),{fill:SHADE,sw:DET,amp:0.15,step:3});}
 const b=M1([2,-4]);s.dot(b[0],b[1],2.4);
 out();}
function crateC(s,cx,cy,S,deg){const[M,M1]=mk(cx,cy,deg),u=(a,b)=>s.pen.u(a,b),h=S/2,b=Math.max(7,S*0.13);
 const[body,out]=s.fo(M(rrect(-h,-h,S,S,3)),{fill:SHADE,amp:S>60?0.5:0.3,step:4});
 const iw=S-2*b,inner=s.shape(M(rrect(-h+b,-h+b,iw,iw,1.5)),{sw:DET,amp:0.3,step:4});
 const nb=Math.max(2,Math.round(iw/17));for(let i=1;i<nb;i++){const x=-h+b+iw*i/nb+u(-.8,.8);const sg=clipLine(M1([x,-h-5]),M1([x,h+5]),inner);if(sg)s.line(sg[0],sg[1],DET,0.3,u(-.4,.4));}
 for(let i=0;i<nb;i+=2){const x=-h+b+iw*(i+0.5)/nb,y=u(-0.3,0.1)*iw;s.grain(M1([x,y]),M1([x+u(-.5,.5),y+Math.min(18,iw*0.3)]));}
 s.shape(M(band(seg2([-h+b+2,-h+b+2],[h-b-2,h-b-2],8),b*0.42)),{fill:SHADE,sw:DET,amp:0.15,step:3});
 for(const[sx,sy]of[[-1,-1],[1,-1],[1,1],[-1,1]]){const p=M1([sx*(h-b/2),sy*(h-b/2)]);s.dot(p[0],p[1],1.4);}
 out();}
function sackC(s,cx,cy,deg,sc=1){const[M]=mk(cx,cy,deg),S=pts=>M(pts.map(([x,y])=>[x*sc,y*sc]));
 s.shape(S([[-7,-27],[-13,-34],[-8,-40],[0,-37.5],[8,-40],[13,-34],[7,-27]]),{sw:DET,amp:0.2,step:2.5});
 const[body,out]=s.fo(S([[-8,-24],[-18,-18],[-27,-4],[-29,10],[-25,26],[-12,35],[0,37],[12,35],[25,26],[29,10],[27,-4],[18,-18],[8,-24]]),{amp:0.5,step:4});
 s.stroke(S([[-9,-17],[-13,-8],[-15,2]]),TEX,0.2,4);s.stroke(S([[3,23],[10,21],[18,17]]),TEX,0.2,4);
 out();
 s.shape(S(band(seg2([-9,-25],[9,-25.5],4),3.2)),{fill:SHADE,sw:DET,amp:0.1,step:2});}
const coin=(s,x,y,r=4.3,fill=PAPER)=>s.shape(circ(x,y,r,14),{fill,sw:DET,amp:0.1,step:1.8});
function gem(s,x,y,r,deg){const p=[];for(let k=0;k<6;k++){const a=(deg+k*60)*Math.PI/180,rr=r*(k%2?0.9:1.05);p.push([x+rr*Math.cos(a),y+rr*Math.sin(a)]);}s.shape(p,{sw:DET,amp:0.05,step:1.5});}
function urnC(s,cx,cy,r,deg,lugs){const[M,M1]=mk(cx,cy,deg),u=(a,b)=>s.pen.u(a,b);
 if(lugs)for(const sx of[-1,1])s.shape(M(rrect(sx>0?r-4:-r-5,-3.5,9,7,3)),{sw:DET,amp:0.08,step:2});
 s.shape(circ(cx,cy,r),{amp:0.4,step:4});
 s.shape(circ(cx+u(-1,1),cy+u(-1,1),r*0.42),{fill:SHADE,sw:DET,amp:0.2,step:2.5});
 const a=u(0,6.28);s.line([cx+r*0.92*Math.cos(a),cy+r*0.92*Math.sin(a)],[cx+r*0.62*Math.cos(a+0.2),cy+r*0.62*Math.sin(a+0.2)],TEX,0.1,0.5);}
function bookC(s,cx,cy,w,h,deg,cover=PAPER){const[M]=mk(cx,cy,deg);
 const[b,out]=s.fo(M(rrect(-w/2,-h/2,w,h,2)),{fill:cover,amp:0.3,step:3});
 s.shape(M(rrect(-w/2,-h/2,7,h,1.5)),{fill:cover===PAPER?SHADE:PAPER,sw:DET,amp:0.15,step:3});
 out();}
function scrollC(s,p0,p1,half){const dx=p1[0]-p0[0],dy=p1[1]-p0[1],l=Math.hypot(dx,dy),nx=-dy/l,ny=dx/l,m=[(p0[0]+p1[0])/2,(p0[1]+p1[1])/2];
 s.shape(band(seg2(p0,p1,8),half),{sw:DET,amp:0.15,step:3});
 s.shape(band(seg2([m[0]-nx*(half+1.5),m[1]-ny*(half+1.5)],[m[0]+nx*(half+1.5),m[1]+ny*(half+1.5)],3),2),{fill:SHADE,sw:DET,amp:0.05,step:1.5});}
function candleC(s,cx,cy,deg){const[M,M1]=mk(cx,cy,deg);
 s.shape(M(rrect(7,-3.5,9,7,3)),{sw:DET,amp:0.08,step:2});s.poly(M([[10.5,-1.2],[13.5,-1.2],[13.5,1.2],[10.5,1.2]]),INK);
 s.shape(circ(cx,cy,10),{fill:SHADE,sw:DET,amp:0.15,step:2});s.shape(circ(cx+0.4,cy-0.3,4.6),{sw:DET,amp:0.08,step:1.5});}

const D={};
D['chest-open']=()=>{const s=new Sheet(1,1,31),u=(a,b)=>s.pen.u(a,b);
 for(const sx of[-1,1]){const ex=sx<0?16:84,o=ex+sx*7;s.shape([[ex-sx*2,47.5],[o,48.5],[o,61.5],[ex-sx*2,62.5]],{fill:SHADE,sw:DET,amp:0.1,step:2.5});const gx=ex+sx*3.8;s.poly([[gx-1,51],[gx+1,51],[gx+1,59],[gx-1,59]],INK);}
 const[lid,lout]=s.fo(rrect(16,12,68,25,3),{amp:0.5,step:4});
 s.seam([5,24.5],[95,24.3],lid);
 for(const bx of[24,69]){s.shape([[bx,11],[bx+7,11],[bx+7,37],[bx,37]],{fill:SHADE,sw:DET,amp:0.2,step:4});s.dot(bx+3.5,17,1.5);}
 lout();
 const[body,out]=s.fo(rrect(16,34,68,40,3),{amp:0.6,step:4});
 s.shape(rrect(22,40,56,28,2),{fill:SHADE,sw:DET,amp:0.3,step:3});
 for(const[x,y]of[[31,48],[40,45],[49,53],[59,47],[67,57],[37,59],[56,62]])coin(s,x+u(-.5,.5),y+u(-.5,.5));
 gem(s,68,46,4.5,10);
 for(const bx of[24,69])for(const[y0,y1]of[[34,40],[68,74]])s.shape([[bx,y0],[bx+7,y0],[bx+7,y1],[bx,y1]],{fill:SHADE,sw:DET,amp:0.1,step:2});
 out();
 s.shape(rrect(42.5,70,15,12,2.5),{fill:SHADE,sw:DET,amp:0.3,step:3});s.dot(50,74.5,2.1);s.poly([[48.9,75.5],[51.1,75.5],[51.9,79],[48.1,79]],INK);
 return s;};
D['barrels']=()=>{const s=new Sheet(2,2,32);
 barrelC(s,52,54,0.92,10);barrelC(s,136,50,0.86,-30);barrelC(s,50,142,0.86,50);sideBarrel(s,138,146,-10);return s;};
D['crate']=()=>{const s=new Sheet(1,1,33);crateC(s,50,50,70,3);return s;};
D['crates']=()=>{const s=new Sheet(2,2,34);
 crateC(s,54,56,84,2);crateC(s,146,64,76,-4);crateC(s,70,146,64,5);crateC(s,150,150,56,-7);crateC(s,104,104,50,14);return s;};
D['sack']=()=>{const s=new Sheet(1,1,35);sackC(s,50,55,8);return s;};
D['sacks']=()=>{const s=new Sheet(2,1,36);sackC(s,58,52,-78,0.9);sackC(s,146,54,72,0.9);sackC(s,102,51,-6,0.8);return s;};
D['supply-shelf']=()=>{const s=new Sheet(2,1,37);
 const[box,out]=s.fo(rrect(8,8,184,48,3));
 s.shape(rrect(14,14,172,36,1.5),{fill:SHADE,sw:DET,amp:0.3});
 s.shape(rot(rrect(20,19,20,26,1.5),30,32,3),{sw:DET,amp:0.15,step:3});
 s.shape(circ(55,31,9),{sw:DET,amp:0.15,step:2.5});s.shape(circ(73,41,6.5),{sw:DET,amp:0.1,step:2});
 const bottle=(p0,p1)=>{const t=0.68,m=[p0[0]+(p1[0]-p0[0])*t,p0[1]+(p1[1]-p0[1])*t];
  s.shape(band(seg2(m,p1,4),2.3),{sw:DET,amp:0.05,step:1.5});
  const c0=[p0[0]+(p1[0]-p0[0])*0.95,p0[1]+(p1[1]-p0[1])*0.95];s.shape(band(seg2(c0,p1,2),2.6),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
  s.shape(band(seg2(p0,[p0[0]+(p1[0]-p0[0])*0.7,p0[1]+(p1[1]-p0[1])*0.7],6),5),{sw:DET,amp:0.1,step:2});};
 bottle([86,28],[112,22]);
 s.shape(rot(rrect(116,26,20,20,1.5),126,36,-6),{sw:DET,amp:0.15,step:3});
 s.shape(circ(151,29,8),{sw:DET,amp:0.12,step:2.5});
 bottle([142,44],[176,43]);
 s.shape(rot(rrect(164,17,17,20,1.5),172,27,5),{sw:DET,amp:0.15,step:3});
 out();return s;};
D['urns']=()=>{const s=new Sheet(1,1,38);urnC(s,36,37,21,15,true);urnC(s,70,63,19,-30,true);urnC(s,29,78,12,0,false);return s;};
D['coins']=()=>{const s=new Sheet(1,1,41),u=(a,b)=>s.pen.u(a,b);
 for(const[x,y]of[[18,26],[84,30],[86,74],[20,82],[58,88]])coin(s,x,y,4.8,SHADE);
 gem(s,74,86,4.5,20);
 s.shape(ell(50,52,30,23),{fill:SHADE,amp:1.4,step:4});
 for(const[x,y]of[[40,44],[52,39],[61,52],[46,59],[33,54],[58,64],[68,44]])coin(s,x+u(-.5,.5),y+u(-.5,.5));
 gem(s,49,49,5,0);gem(s,37,65,4.2,25);
 return s;};
D['hoard']=()=>{const s=new Sheet(2,2,42),u=(a,b)=>s.pen.u(a,b);
 for(const[x,y]of[[26,32],[176,30],[186,112],[14,120],[40,188]])coin(s,x,y,4.8,SHADE);
 s.shape(ell(100,118,82,64),{fill:SHADE,amp:2,step:5});
 chestC(s,100,62,-7);
 s.shape(ell(100,92,48,13),{fill:SHADE,sw:DET,amp:1.2,step:4});
 const[M,M1]=mk(58,134,28);
 s.shape(M(band(seg2([-20,0],[-3,0],4),2.2)),{sw:DET,amp:0.05,step:1.5});
 s.shape(M(band(seg2([-21,-8],[-21,8],4),2.6)),{sw:DET,amp:0.05,step:1.5});
 s.shape(M([[-4,-3],[0,-9],[10,-11.5],[19,-10.5],[19,10.5],[10,11.5],[0,9],[-4,3]]),{sw:DET,amp:0.1,step:2});
 s.line(M1([15.5,-9.5]),M1([15.5,9.5]),DET,0.05);
 const cr=[],R=15;for(let k=0;k<48;k++){const t=6.2832*k/48;cr.push([146+(R+2.2*Math.cos(8*t))*Math.cos(t),128+(R+2.2*Math.cos(8*t))*Math.sin(t)]);}
 s.shape(cr,{sw:DET,amp:0.05,step:1.5});s.shape(circ(146,128,9.5),{fill:SHADE,sw:DET,amp:0.1,step:2});
 for(const[x,y]of[[40,106],[62,98],[84,118],[104,110],[122,142],[96,146],[74,160],[114,166],[150,100],[166,152],[140,168],[46,152]])coin(s,x+u(-1,1),y+u(-1,1));
 gem(s,108,128,5.5,10);gem(s,60,114,4.5,30);gem(s,164,112,4.5,0);
 return s;};
D['weapon-rack']=()=>{const s=new Sheet(2,1,43);
 s.shape(rrect(10,10,180,12,3),{fill:SHADE});s.shape(rrect(10,70,180,12,3),{fill:SHADE});
 const sword=(x,deg)=>{const[M]=mk(x,50,deg,x,50);
  s.shape(M([[x-4,31],[x+4,31],[x+3.6,72],[x,86],[x-3.6,72]]),{sw:DET,amp:0.1,step:3});
  s.shape(M(band(seg2([x,18],[x,27],3),2.5)),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
  s.shape(M(band(seg2([x-10,29.5],[x+10,29.5],4),2.4)),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
  s.shape(M(circ(x,14.5,3.6,12)),{sw:DET,amp:0.05,step:1.5});};
 const spear=(x,deg)=>{const[M]=mk(x,50,deg,x,50);
  s.shape(M(band(seg2([x,34],[x,88],8),2)),{sw:DET,amp:0.1,step:2.5});
  s.shape(M([[x,11],[x+4.8,21],[x+3,30],[x,33],[x-3,30],[x-4.8,21]]),{sw:DET,amp:0.08,step:2});
  s.shape(M(band(seg2([x,33],[x,38],2),2.8)),{fill:SHADE,sw:DET,amp:0.05,step:1.5});};
 sword(32,-2);sword(54,1.5);spear(78,2);spear(98,-1.5);
 const[M]=mk(124,50,1,124,50);
 s.shape(M(band(seg2([124,17],[124,88],8),2.6)),{sw:DET,amp:0.1,step:2.5});
 s.shape(M([[125,18],[138,12],[146,14],[148,28],[144,42],[136,42],[125,34]]),{sw:DET,amp:0.15,step:2.5});
 s.shape(M(band(seg2([124,18],[124,34],3),3.4)),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 spear(168,-2.5);
 return s;};
D['armor-stand']=()=>{const s=new Sheet(1,1,44);
 const[base,out]=s.fo(circ(50,52,36),{amp:0.5});s.line([30,74],[46,80],TEX,0.2,0.8);s.line([60,24],[74,30],TEX,0.2,-0.6);out();
 s.shape(ell(50,59,22,15),{fill:SHADE,amp:0.4,step:3});
 s.shape(rot(ell(29,51,10.5,14),29,51,22),{amp:0.3,step:3});s.shape(rot(ell(71,51,10.5,14),71,51,-22),{amp:0.3,step:3});
 s.dot(28,46,1.4);s.dot(72,46,1.4);
 s.shape(ell(50,49,13,14),{amp:0.25,step:3});
 const arc=[];for(let a=30;a<=150;a+=10)arc.push([50+10.5*Math.cos(a*Math.PI/180),49+11.5*Math.sin(a*Math.PI/180)]);
 s.shape(band(arc,2.6),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 return s;};
D['war-table']=()=>{const s=new Sheet(2,2,45),u=(a,b)=>s.pen.u(a,b);
 const[top,out]=s.fo(rrect(12,12,176,176,4));
 for(let i=1;i<10;i++){const x=12+17.6*i+u(-.6,.6);s.seam([x,4],[x+u(-.4,.4),196],top);}
 for(const[x,a,b]of[[20,18,34],[56,160,176],[110,18,32],[146,164,180],[180,60,76],[22,120,136]])s.grain([x,a],[x+u(-.5,.5),b]);
 const[M,M1]=mk(100,97,-4,100,97);
 const[map,mout]=s.fo(M(rrect(36,38,128,118,2)),{amp:0.3,step:4});
 const coast=[[118,38],[110,58],[124,78],[116,102],[130,124],[138,156]];
 s.fill(M([...coast,[164,156],[164,38]]),{fill:SHADE,amp:0.2,step:4});
 s.stroke(M(coast),DET,0.3,4);
 s.stroke(M([[60,70],[74,84],[90,86],[104,100],[119,104]]),TEX,0.2,5);
 s.stroke(M([[42,120],[62,112],[80,122],[98,134],[106,150]]),TEX,0.2,5);
 s.stroke(M([[70,40],[76,56],[68,66]]),TEX,0.2,5);
 mout();
 for(const[x,y]of[[70,68],[86,122],[58,104]])s.shape(circ(x,y,5,12),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 s.shape(circ(144,112,5,12),{sw:DET,amp:0.05,step:1.5});
 s.shape(rot(rrect(92,78,9,9,1.5),96.5,82.5,12),{sw:DET,amp:0.05,step:1.5});
 out();
 candleC(s,30,30,200);candleC(s,170,172,20);
 return s;};
D['books']=()=>{const s=new Sheet(1,1,46);
 bookC(s,38,46,40,30,10);bookC(s,40,43,36,27,-6,SHADE);bookC(s,40,41,31,23,3);
 const[M]=mk(80,46,-5,80,46);
 s.shape(M(rrect(71,30,18,32,1)),{sw:DET,amp:0.1,step:2.5});
 s.shape(M(band(seg2([71,30],[89,30],4),3.5)),{sw:DET,amp:0.05,step:1.5});
 s.shape(M(band(seg2([71,62],[89,62],4),3.5)),{sw:DET,amp:0.05,step:1.5});
 scrollC(s,[20,80],[56,73],5.5);scrollC(s,[52,88],[84,82],5);
 return s;};
D['mirror']=()=>{const s=new Sheet(1,1,47);
 for(const x of[18,82])s.shape(band(seg2([x,28],[x,72],6),3.5),{sw:DET,amp:0.1,step:2});
 s.shape(rrect(17,46,9,8,2),{fill:SHADE,sw:DET,amp:0.05,step:1.5});s.shape(rrect(74,46,9,8,2),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 const fr=[];for(let k=0;k<60;k++){const t=6.2832*k/60,m=1+0.05*Math.cos(12*t);fr.push([50+27*m*Math.cos(t),50+15*m*Math.sin(t)]);}
 s.shape(fr,{amp:0.1,step:2});
 s.shape(ell(50,50,19.5,8.5),{fill:SHADE,sw:DET,amp:0.15,step:2});
 s.shape([[44.5,36.5],[47,32],[50,28.5],[53,32],[55.5,36.5],[50,38]],{sw:DET,amp:0.05,step:1.5});
 return s;};

const COPY={'chest-closed':'_ref/chest.svg','barrel-single':'_ref/barrel.svg'};
const META=[
 ['storage','chest-closed','Closed Chest',1,1,['chest','closed','locked','container','storage','wood','iron'],'movement'],
 ['storage','chest-open','Open Chest with Coins',1,1,['chest','open','coins','treasure','container','wood','iron'],'movement'],
 ['storage','barrel-single','Single Barrel',1,1,['barrel','container','storage','wood','cellar','tavern'],'movement'],
 ['storage','barrels','Barrel Cluster',2,2,['barrels','cluster','container','storage','wood','cellar','warehouse'],'movement'],
 ['storage','crate','Wooden Crate',1,1,['crate','box','container','storage','wood','warehouse'],'movement'],
 ['storage','crates','Stacked Crates',2,2,['crates','stack','container','storage','wood','warehouse','dock'],'sight'],
 ['storage','sack','Grain Sack',1,1,['sack','grain','cloth','storage','cellar','farm'],'movement'],
 ['storage','sacks','Pile of Sacks',2,1,['sacks','pile','grain','cloth','storage','warehouse'],'movement'],
 ['storage','supply-shelf','Supply Shelf',2,1,['shelf','jars','bottles','boxes','storage','pantry','wood'],'sight'],
 ['storage','urns','Clay Urns',1,1,['urns','clay','pottery','container','storage','tomb'],'movement'],
 ['treasure','coins','Coin Pile',1,1,['coins','gems','gold','treasure','loot','pile'],'none'],
 ['treasure','hoard','Treasure Hoard',2,2,['hoard','coins','goblet','crown','chest','treasure','dragon'],'movement'],
 ['treasure','weapon-rack','Weapon Rack',2,1,['weapons','rack','sword','spear','axe','armory','barracks'],'movement'],
 ['treasure','armor-stand','Armor Stand',1,1,['armor','stand','helmet','plate','armory','metal'],'movement'],
 ['treasure','war-table','War Table with Map',2,2,['table','map','war','markers','candles','command','strategy'],'movement'],
 ['treasure','books','Books and Scrolls',1,1,['books','scrolls','stack','study','library','paper'],'none'],
 ['treasure','mirror','Ornate Standing Mirror',1,1,['mirror','standing','ornate','glass','bedroom','noble'],'movement']];
const inner={};const report={};
for(const[cat,id,,w,h]of META){let svg,els;
 if(COPY[id]){const raw=await readFile(COPY[id]);els=raw.replace(/<metadata>[\s\S]*?<\/metadata>/,'').split('\n').filter(l=>/^\s*<(path|polygon|circle|rect|ellipse|line|polyline)\b/.test(l)).map(l=>l.trim().replace(/><\/(path|polygon|circle|rect|ellipse|line|polyline)>$/,'/>'));
  svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w*100}" height="${h*100}" viewBox="0 0 ${w*100} ${h*100}">\n`+els.map(e=>'  '+e).join('\n')+'\n</svg>\n';report[id]={copied:els.length};}
 else{const s=D[id]();if(s.W!==w*100||s.H!==h*100)throw id+' size';svg=s.svg();els=s.els;report[id]={bad:s.bad.slice(0,3)};}
 const cols=[...new Set(svg.match(/#[0-9A-Fa-f]{6}/g))].filter(c=>![INK,PAPER,SHADE].includes(c));
 const widths=[...new Set(svg.match(/stroke-width="[^"]+"/g))].filter(x=>!/"(4|2|1\.5)"/.test(x));
 if(cols.length||widths.length||/metadata|<text|opacity|class=|style=/.test(svg))report[id].problem={cols,widths};
 await saveFile(`${cat}/${id}.svg`,svg);inner[id]=els;}
for(const cat of['storage','treasure']){const list=META.filter(m=>m[0]===cat);let x=100;const W=100+list.reduce((a,m)=>a+(m[3]+1)*100,0);
 let grid='';for(let gx=100;gx<W;gx+=100)grid+=`M${gx} 0V400`;for(const gy of[100,200,300])grid+=`M0 ${gy}H${W}`;
 let card=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="400" viewBox="0 0 ${W} 400">\n  <rect width="${W}" height="400" fill="#F0ECE0"/>\n  <path d="${grid}" fill="none" stroke="#DDD6C3" stroke-width="1.5"/>\n`;
 for(const[,id,,w,h]of list){card+=`  <svg x="${x}" y="${300-h*100}" width="${w*100}" height="${h*100}" viewBox="0 0 ${w*100} ${h*100}">\n`+inner[id].map(e=>'  '+e).join('\n')+`\n  </svg>\n  <text x="${x+w*50}" y="336" text-anchor="middle" font-family="ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="20" fill="#4A4336">${id}</text>\n`;x+=(w+1)*100;}
 await saveFile(`overview/${cat}.svg`,card+'</svg>\n');}
const man=JSON.parse(await readFile('manifest.json')).filter(e=>e.category!=='storage'&&e.category!=='treasure');
const all=[...man,...META.map(([category,id,name,w,h,tags,blocks])=>({id,name,category,w,h,tags,blocks}))];
const ids=all.map(e=>e.id);if(new Set(ids).size!==ids.length)throw 'duplicate id';
await saveFile('manifest.json','[\n'+all.map(e=>'  '+JSON.stringify(e).replace(/,"/g,', "').replace(/":/g,'": ')).join(',\n')+'\n]\n');
log(JSON.stringify(report));
