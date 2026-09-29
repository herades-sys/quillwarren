// Terrain tiles (seamless 200×200, transparent). Run after the toolkit half of tools/furniture.js.
const SW=[1.5,2,2.5];
class Tile{constructor(seed){this.pen=new Pen(seed);this.els=[];}
 u(a,b){return this.pen.u(a,b);}
 emit(wp,closed,fill,stroke,sw){const xs=wp.map(p=>p[0]),ys=wp.map(p=>p[1]),m=(sw||0)+1;
  const x0=Math.min(...xs)-m,x1=Math.max(...xs)+m,y0=Math.min(...ys)-m,y1=Math.max(...ys)+m;
  let a=`fill="${fill}" stroke="${stroke}"`;if(stroke!==NONE){if(!SW.includes(sw))throw'sw '+sw;a+=` stroke-width="${fmt(sw)}" stroke-linecap="round" stroke-linejoin="round"`;}
  for(const dx of[-200,0,200])for(const dy of[-200,0,200]){if(x1+dx<0||x0+dx>200||y1+dy<0||y0+dy>200)continue;
   this.els.push(`<path d="${bez(wp.map(p=>[p[0]+dx,p[1]+dy]),closed)}" ${a}/>`);}}
 shape(pts,o={}){const{fill=NONE,stroke=INK,sw=2,amp=0.3,step=3}=o;const wp=this.pen.wobble(pts,true,amp,step,[22,60]);this.emit(wp,true,fill,stroke,sw);return wp;}
 raw(pts,o={}){const{fill=SHADE,stroke=NONE,sw=0}=o;this.emit(pts,true,fill,stroke,sw);}
 stroke(pts,sw=1.5,amp=0.25,step=4,col=INK){const wp=this.pen.wobble(pts,false,amp,step,[18,45]);this.emit(wp,false,NONE,col,sw);return wp;}
 line(p0,p1,sw=1.5,amp=0.25,bow=0,col=INK){const l=L(p0,p1),n=Math.max(2,Math.floor(l/5)),nx=-(p1[1]-p0[1])/l,ny=(p1[0]-p0[0])/l,pts=[];
  for(let k=0;k<=n;k++){const t=k/n,b=bow*Math.sin(Math.PI*t);pts.push([p0[0]+(p1[0]-p0[0])*t+nx*b,p0[1]+(p1[1]-p0[1])*t+ny*b]);}return this.stroke(pts,sw,amp,5,col);}
 dot(x,y,r,fill=INK){const p=circ(x,y,r,10);this.emit(p,true,fill,NONE,0);}
 hline(y,sw=2,amp=0.5,col=INK){const nz=this.pen.noise(200,amp,true,[40,100]),pts=[];for(let x=-6;x<=206;x+=5)pts.push([x,y+nz(((x%200)+200)%200)]);this.els.push(`<path d="${bez(pts,false)}" fill="none" stroke="${col}" stroke-width="${fmt(sw)}" stroke-linecap="round" stroke-linejoin="round"/>`);}
 svg(){return`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">\n`+this.els.map(e=>'  '+e).join('\n')+'\n</svg>\n';}}
const td=(a,b)=>{let dx=Math.abs(a[0]-b[0]),dy=Math.abs(a[1]-b[1]);dx=Math.min(dx,200-dx);dy=Math.min(dy,200-dy);return Math.hypot(dx,dy);};
function poisson(t,minD,tries=600,avoid=[]){const pts=[];for(let i=0;i<tries;i++){const p=[t.u(0,200),t.u(0,200)];if(pts.every(q=>td(p,q)>=minD)&&avoid.every(([q,r])=>td(p,q)>=r))pts.push(p);}return pts;}
function jgrid(t,n,j){const s=200/n,p=[];for(let i=0;i<n;i++)for(let k=0;k<n;k++)p.push([(i+0.5)*s+t.u(-j,j)*s,(k+0.5)*s+t.u(-j,j)*s]);return p;}
function clipHalf(poly,m,n){const out=[];for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length];const da=(a[0]-m[0])*n[0]+(a[1]-m[1])*n[1],db=(b[0]-m[0])*n[0]+(b[1]-m[1])*n[1];
 if(da<=0)out.push(a);if((da<0)!==(db<0)&&da!==db){const t=da/(da-db);out.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}}return out;}
function voronoi(sites){const all=[];sites.forEach((s,i)=>{for(const dx of[-200,0,200])for(const dy of[-200,0,200])all.push([s[0]+dx,s[1]+dy,i,dx,dy]);});
 return sites.map((s,i)=>{let poly=[[s[0]-150,s[1]-150],[s[0]+150,s[1]-150],[s[0]+150,s[1]+150],[s[0]-150,s[1]+150]];const nb=[];
  for(const o of all){if(o[2]===i&&!o[3]&&!o[4])continue;if(Math.hypot(o[0]-s[0],o[1]-s[1])>200)continue;poly=clipHalf(poly,[(s[0]+o[0])/2,(s[1]+o[1])/2],[o[0]-s[0],o[1]-s[1]]);}
  return poly;});}
const cen=p=>[p.reduce((a,q)=>a+q[0],0)/p.length,p.reduce((a,q)=>a+q[1],0)/p.length];
function inset(poly,d){const c=cen(poly);let out=poly.slice();for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length];let n=[-(b[1]-a[1]),b[0]-a[0]];const l=Math.hypot(...n)||1;n=[n[0]/l,n[1]/l];
 if((c[0]-a[0])*n[0]+(c[1]-a[1])*n[1]<0)n=[-n[0],-n[1]];out=clipHalf(out,[a[0]+n[0]*d,a[1]+n[1]*d],[-n[0],-n[1]]);if(out.length<3)return null;}return out;}
function chaikin(p,it){for(let k=0;k<it;k++){const q=[];for(let i=0;i<p.length;i++){const a=p[i],b=p[(i+1)%p.length];q.push([a[0]*0.75+b[0]*0.25,a[1]*0.75+b[1]*0.25],[a[0]*0.25+b[0]*0.75,a[1]*0.25+b[1]*0.75]);}p=q;}return p;}
function blob(t,x,y,r,n=9,j=0.25){const p=[];for(let k=0;k<n;k++){const a=6.2832*k/n+t.u(-.2,.2),rr=r*t.u(1-j,1+j*0.4);p.push([x+rr*Math.cos(a),y+rr*Math.sin(a)]);}return chaikin(p,2);}
function ang(t,x,y,r){const n=t.u(0,1)<0.5?5:6,p=[];for(let k=0;k<n;k++){const a=6.2832*k/n+t.u(-.3,.3),rr=r*t.u(0.75,1.1);p.push([x+rr*Math.cos(a),y+rr*Math.sin(a)]);}return p;}
function edges(polys){const e=[];for(const p of polys)for(let i=0;i<p.length;i++)e.push([p[i],p[(i+1)%p.length]]);return e;}
function wave(t,x,y,Lh,A,sw,col=INK){const pts=[];for(let k=0;k<=12;k++){const s=-1+2*k/12;pts.push([x+s*Lh,y+A*Math.sin(Math.PI*1.5*s)]);}t.stroke(pts,sw,0.1,3,col);}
function crack(t,p,deg,len,segs,sw=1.5){const pts=[p];let a=deg;for(let k=0;k<segs;k++){a+=t.u(-35,35);const q=pts[pts.length-1];pts.push([q[0]+Math.cos(a*Math.PI/180)*len/segs,q[1]+Math.sin(a*Math.PI/180)*len/segs]);}t.stroke(pts,sw,0.1,3);return pts;}
const TT={};
TT['water-shallow']=()=>{const t=new Tile(201);for(const p of poisson(t,34))wave(t,p[0],p[1],t.u(9,15),t.u(1.4,2.2),t.u(0,1)<0.5?1.5:2);return t;};
TT['water-deep']=()=>{const t=new Tile(202);for(const p of poisson(t,22)){const Lh=t.u(11,17);if(t.u(0,1)<0.5){const q=[];for(let k=0;k<=10;k++){const s=-1+2*k/10;q.push([p[0]+s*Lh*0.8,p[1]+3+2.6*Math.cos(Math.PI*s/2)]);}for(let k=10;k>=0;k--){const s=-1+2*k/10;q.push([p[0]+s*Lh*0.8,p[1]+3+0.6*Math.cos(Math.PI*s/2)]);}t.raw(q);}wave(t,p[0],p[1],Lh,t.u(2,3),t.u(0,1)<0.5?2:2.5);}return t;};
TT['lava']=()=>{const t=new Tile(203),V=voronoi(jgrid(t,4,0.3));
 for(const[a,b]of edges(V))t.raw(band(seg2(a,b,3),3.4,4),{fill:SHADE});
 for(const p of V){const q=inset(p,4.6);if(!q)continue;t.shape(chaikin(q,1),{sw:2,amp:0.35});if(t.u(0,1)<0.45){const c=cen(q);crack(t,[c[0]+t.u(-6,6),c[1]+t.u(-6,6)],t.u(0,360),t.u(10,18),3);}}return t;};
TT['grass']=()=>{const t=new Tile(204);for(const p of poisson(t,30)){const n=t.u(0,1)<0.5?3:4;for(let k=0;k<n;k++){const a=(-90+(k-(n-1)/2)*t.u(18,28))*Math.PI/180,l=t.u(5,10),b=[p[0]+(k-(n-1)/2)*1.4,p[1]];t.stroke([b,[b[0]+Math.cos(a)*l*0.5+0.6,b[1]+Math.sin(a)*l*0.5],[b[0]+Math.cos(a)*l,b[1]+Math.sin(a)*l]],1.5,0.05,2);}}return t;};
TT['dirt']=()=>{const t=new Tile(205),P=poisson(t,24);P.forEach((p,i)=>{if(i%3===2){crack(t,p,t.u(0,360),t.u(14,24),3);}else if(i%3===1){const r=t.u(2.4,4.8);t.shape(ang(t,p[0],p[1],r),{fill:SHADE,sw:1.5,amp:0.1,step:1.5});}else{for(let k=0;k<3;k++)t.dot(p[0]+t.u(-4,4),p[1]+t.u(-4,4),0.9);}});return t;};
TT['mud']=()=>{const t=new Tile(206),P=poisson(t,70,300);for(const p of P.slice(0,4))t.shape(blob(t,p[0],p[1],t.u(12,19),10,0.3),{fill:SHADE,sw:2,amp:0.4});
 for(const p of poisson(t,30,600,P.slice(0,4).map(q=>[q,32]))){const l=t.u(12,20),a=t.u(-25,25)*Math.PI/180,b=t.u(2.5,4)*(t.u(0,1)<0.5?1:-1),pts=[];for(let k=0;k<=8;k++){const s=-1+2*k/8;pts.push([p[0]+Math.cos(a)*s*l-Math.sin(a)*b*(1-s*s),p[1]+Math.sin(a)*s*l+Math.cos(a)*b*(1-s*s)]);}t.stroke(pts,1.5,0.05,3);}return t;};
TT['swamp']=()=>{const t=new Tile(207),M=poisson(t,64,300).slice(0,5);for(const p of M)t.shape(blob(t,p[0],p[1],t.u(16,26),11,0.35),{fill:SHADE,stroke:NONE,amp:0.4});
 const P=poisson(t,30,600,M.map(q=>[q,26]));P.forEach((p,i)=>{if(i%5===0){for(const[dx,dy,r]of[[0,0,t.u(11,13)]]){const c=[p[0]+dx,p[1]+dy],a0=t.u(0,360),pts=[c];for(let k=0;k<=16;k++){const a=(a0+18+324*k/16)*Math.PI/180;pts.push([c[0]+r*Math.cos(a),c[1]+r*Math.sin(a)]);}t.shape(pts,{fill:SHADE,sw:1.5,amp:0.1,step:2});}}
  else if(i%3===1){for(let k=0;k<4;k++){const a=(-90+(k-1.5)*t.u(10,18))*Math.PI/180,l=t.u(9,15),b=[p[0]+(k-1.5)*2,p[1]];t.stroke([b,[b[0]+Math.cos(a)*l,b[1]+Math.sin(a)*l]],1.5,0.1,3);}}});return t;};
TT['sand']=()=>{const t=new Tile(208);for(let r=0;r<7;r++){const y0=14+r*28.6+t.u(-3,3),k=t.u(0,1)<0.5?1:2,ph=t.u(0,6.28),A=t.u(2,4),f=x=>y0+A*Math.sin(6.2832*k*x/200+ph)+2*Math.sin(6.2832*3*x/200+ph*2);
  let x=t.u(0,40);while(x<200){const l=t.u(26,52),pts=[];for(let s=0;s<=l;s+=4)pts.push([x+s,f(x+s)]);t.stroke(pts,1.5,0.05,4);x+=l+t.u(14,34);}}
 for(const p of poisson(t,14,500))if(t.u(0,1)<0.45)t.dot(p[0],p[1],0.85);return t;};
TT['snow']=()=>{const t=new Tile(209);for(const p of poisson(t,58,300)){const l=t.u(26,40),a=t.u(-12,12)*Math.PI/180,pts=[];for(let k=0;k<=10;k++){const s=-1+2*k/10;pts.push([p[0]+Math.cos(a)*s*l-Math.sin(a)*4*(1-s*s),p[1]+Math.sin(a)*s*l+Math.cos(a)*(-4)*(1-s*s)]);}t.stroke(pts,2.5,0.2,4,SHADE);}
 const st=[40,150],dir=[1,-0.62],n=Math.hypot(...dir);for(let k=0;k<5;k++){const c=[st[0]+dir[0]/n*18*k,st[1]+dir[1]/n*18*k],side=k%2?1:-1,px=[c[0]-dir[1]/n*4*side,c[1]+dir[0]/n*4*side];t.shape(rot(ell(px[0],px[1],2.2,3.8),px[0],px[1],Math.atan2(dir[1],dir[0])*180/Math.PI+90),{fill:SHADE,stroke:NONE,amp:0.05,step:1.2});}return t;};
TT['ice']=()=>{const t=new Tile(210);for(const[p,a,l]of[[[6,26],18,150],[[60,104],-8,120],[[118,170],22,96],[[150,58],28,40]]){const pts=[p];let ang=a;for(let k=0;k<Math.round(l/16);k++){ang+=t.u(-14,14);const q=pts[pts.length-1];pts.push([q[0]+Math.cos(ang*Math.PI/180)*16,q[1]+Math.sin(ang*Math.PI/180)*16]);}t.stroke(pts,1.5,0.1,3);{const q=pts[Math.floor(pts.length/2)];crack(t,q,a+t.u(28,40),t.u(12,18),2);}}
 for(const p of poisson(t,70,200).slice(0,3)){const l=t.u(16,26),a=-30*Math.PI/180;t.raw([[p[0]-Math.cos(a)*l,p[1]-Math.sin(a)*l],[p[0]+2,p[1]-1.4],[p[0]+Math.cos(a)*l,p[1]+Math.sin(a)*l],[p[0]-2,p[1]+1.4]].map(q=>q),{fill:SHADE});}return t;};
TT['cave-floor']=()=>{const t=new Tile(211),V=voronoi(jgrid(t,3,0.3));
 for(const p of poisson(t,70,200).slice(0,3))t.shape(blob(t,p[0],p[1],t.u(14,22),10,0.35),{fill:SHADE,stroke:NONE,amp:0.4});
 for(const[a,b]of edges(V)){if(t.u(0,1)<0.4)continue;const pts=[a];for(let k=1;k<4;k++){const s=k/4,n=[-(b[1]-a[1]),b[0]-a[0]],l=Math.hypot(...n);pts.push([a[0]+(b[0]-a[0])*s+n[0]/l*t.u(-4,4),a[1]+(b[1]-a[1])*s+n[1]/l*t.u(-4,4)]);}pts.push(b);t.stroke(pts,2,0.2,3);}
 for(const p of poisson(t,48,200).slice(0,6))t.shape(blob(t,p[0],p[1],t.u(2.5,4),7,0.3),{sw:1.5,amp:0.1,step:1.5});return t;};
TT['flagstones']=()=>{const t=new Tile(212),V=voronoi(jgrid(t,3,0.18).concat([[t.u(0,200),t.u(0,200)]]));
 V.forEach((p,i)=>{const q=inset(p,2.6);if(!q)return;t.shape(chaikin(q,1),{fill:i%5===3?SHADE:NONE,sw:2.5,amp:0.4,step:4});if(i%3===0){const c=cen(q);crack(t,[c[0]+t.u(-10,10),c[1]+t.u(-10,10)],t.u(0,360),t.u(14,22),3);}});return t;};
TT['cobblestones']=()=>{const t=new Tile(213),V=voronoi(jgrid(t,8,0.28));V.forEach((p,i)=>{const q=inset(p,2.4);if(!q)return;t.shape(chaikin(q,2),{fill:t.u(0,1)<0.2?SHADE:NONE,sw:2,amp:0.2,step:2.5});});return t;};
TT['wood-planks']=()=>{const t=new Tile(214);for(let r=0;r<10;r++){const y=r*20;t.hline(y+0.01,2,0.35);
  let x=t.u(0,200);const x0=x;while(x<x0+200){const l=t.u(84,140);const jx=x;t.line([jx,y+1.5],[jx+0.3,y+18.5],2,0.1);for(const[s,dy]of[[-3.5,6],[3.5,14]])t.dot(jx+s,y+dy,1.1);
   const g=t.u(0,1)<0.6?1:0;for(let k=0;k<g;k++){const gx=jx+t.u(10,l-30),gy=y+t.u(6,14);t.line([gx,gy],[gx+t.u(12,22),gy+t.u(-.6,.6)],1.5,0.1,t.u(-0.8,0.8));}x+=l;}}return t;};
TT['carpet']=()=>{const t=new Tile(215);for(const c of[0,50,100,150]){t.line([c,0],[c+200,200],2,0.3);t.line([c,200],[c+200,0],2,0.3);}
 for(let i=0;i<8;i++)for(let j=0;j<4;j++){const x=25*i,y=50*j+(i%2?25:0);if((i+j)%2){t.shape([[x,y-9],[x+9,y],[x,y+9],[x-9,y]],{fill:SHADE,sw:1.5,amp:0.1,step:2});}else{for(const[dx,dy]of[[0,-6],[6,0],[0,6],[-6,0]])t.dot(x+dx,y+dy,1.6);}}
 for(let i=0;i<4;i++)for(let j=0;j<4;j++)t.dot(50*i,50*j,2.2),t.dot(50*i+25,50*j+25,2.2);return t;};
TT['rubble-field']=()=>{const t=new Tile(216),big=poisson(t,56,300).slice(0,7);
 for(const p of big){const r=t.u(9,13);t.shape(ang(t,p[0],p[1],r),{fill:t.u(0,1)<0.4?SHADE:NONE,sw:2.5,amp:0.3,step:3});if(t.u(0,1)<0.5)t.line([p[0]-r*0.4,p[1]-r*0.2],[p[0]+r*0.2,p[1]+r*0.35],1.5,0.05);}
 const mid=poisson(t,22,600,big.map(q=>[q,22]));mid.forEach((p,i)=>{const r=i%2?t.u(5,8):t.u(2.4,3.6);t.shape(ang(t,p[0],p[1],r),{fill:r<4||t.u(0,1)<0.35?SHADE:NONE,sw:r>4?2:1.5,amp:0.1,step:2});});return t;};
TT['chasm']=()=>{const t=new Tile(217),V=voronoi(jgrid(t,3,0.25)),ledge=new Set([0,1,5,6]);
 V.forEach((p,i)=>{if(!ledge.has(i))t.raw(p,{fill:SHADE,stroke:SHADE,sw:1.5});});
 V.forEach((p,i)=>{if(ledge.has(i)){const q=inset(p,1.8);if(q){t.shape(chaikin(q,1),{sw:2.5,amp:0.6,step:4});const c=cen(q);t.line([c[0]-8,c[1]-3],[c[0]+6,c[1]+4],1.5,0.1,1);}}});
 V.forEach((p,i)=>{if(!ledge.has(i)&&i%2===0){const c=cen(p);crack(t,[c[0]+t.u(-8,8),c[1]+t.u(-8,8)],t.u(0,360),t.u(20,34),4);}});return t;};
TT['moss']=()=>{const t=new Tile(218),M=poisson(t,62,300).slice(0,5);for(const p of M){const b=t.shape(blob(t,p[0],p[1],t.u(14,22),12,0.35),{fill:SHADE,stroke:NONE,amp:0.5});const n=b.length,s=Math.floor(t.u(0,n));t.stroke([...b,...b].slice(s,s+Math.floor(n*0.45)),1.5,0.05,3);}
 for(const p of poisson(t,26,600,M.map(q=>[q,22]))){if(t.u(0,1)<0.4){for(let k=0;k<3;k++){const a=(-90+(k-1)*30+t.u(-8,8))*Math.PI/180,l=t.u(4,6);t.stroke([p,[p[0]+Math.cos(a)*l*0.5+0.8,p[1]+Math.sin(a)*l*0.5],[p[0]+Math.cos(a)*l,p[1]+Math.sin(a)*l]],1.5,0.03,2);}}else for(let k=0;k<5;k++)t.dot(p[0]+t.u(-6,6),p[1]+t.u(-6,6),0.95);}return t;};

const TMETA=[
 ['water-shallow','Shallow Water','#BFD8DC',false],['water-deep','Deep Water','#86ADBD',false],['lava','Lava','#E3824A',false],
 ['grass','Grass','#C3D69E',false],['dirt','Packed Dirt','#CFB590',false],['mud','Mud','#A38C6E',true],
 ['swamp','Swamp','#9AAA84',true],['sand','Sand','#E8D8AA',false],['snow','Snow','#F6F6F3',true],
 ['ice','Ice','#D6E8EF',false],['cave-floor','Cave Floor','#BDB7AB',false],['flagstones','Flagstones','#D2CBBB',false],
 ['cobblestones','Cobblestones','#C7BFAF',false],['wood-planks','Wood Planks','#CDA674',false],['carpet','Carpet','#B35A52',false],
 ['rubble-field','Rubble Field','#C0B8A9',true],['chasm','Chasm','#B3ADA4',false],['moss','Moss','#A3B67E',false]];
const tiles={},rep={};
for(const[id]of TMETA){const t=TT[id]();const svg=t.svg();
 const cols=[...new Set(svg.match(/#[0-9A-Fa-f]{6}/g))].filter(c=>![INK,SHADE].includes(c));const w=[...new Set(svg.match(/stroke-width="[^"]+"/g))].filter(x=>!/"(1\.5|2|2\.5)"/.test(x));
 rep[id]={els:t.els.length,...(cols.length||w.length?{cols,w}:{})};await saveFile(`terrain/${id}.svg`,svg);tiles[id]=t.els;}
{const C=6,Wd=100+C*700,rows=Math.ceil(TMETA.length/C),Hd=100+rows*800;let card=`<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}" height="${Hd}" viewBox="0 0 ${Wd} ${Hd}">\n  <rect width="${Wd}" height="${Hd}" fill="#F0ECE0"/>\n`;
 TMETA.forEach(([id,,tint],i)=>{const bx=100+(i%C)*700,by=100+Math.floor(i/C)*800;card+=`  <rect x="${bx}" y="${by}" width="600" height="600" fill="${tint}"/>\n`;
  for(let a=0;a<3;a++)for(let b=0;b<3;b++)card+=`  <svg x="${bx+a*200}" y="${by+b*200}" width="200" height="200" viewBox="0 0 200 200">\n`+tiles[id].map(e=>'  '+e).join('\n')+'\n  </svg>\n';
  card+=`  <text x="${bx+300}" y="${by+636}" text-anchor="middle" font-family="ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="20" fill="#4A4336">${id}</text>\n`;});
 await saveFile('overview/terrain.svg',card+'</svg>\n');}
const man=JSON.parse(await readFile('manifest.json')).filter(e=>e.kind!=='terrain');
const all=[...man,...TMETA.map(([id,name,tint,difficult])=>({id,name,kind:'terrain',tile:2,tint,difficult}))];
const ids=all.map(e=>e.id);if(new Set(ids).size!==ids.length)throw 'duplicate id '+ids.filter((x,i)=>ids.indexOf(x)!==i);
await saveFile('manifest.json','[\n'+all.map(e=>'  '+JSON.stringify(e).replace(/,"/g,', "').replace(/":/g,'": ')).join(',\n')+'\n]\n');
log(JSON.stringify(rep));
