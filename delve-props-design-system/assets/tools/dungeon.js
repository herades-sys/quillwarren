// Dungeon batch. Run after tools/furniture.js toolkit + tools/storage.js helpers + tools/temple.js helpers.
function stone(s,cx,cy,r,o={}){const{n=7,deg=0,fill=PAPER,sw=OUT,crack=false}=o,u=(a,b)=>s.pen.u(a,b),p=[];
 for(let k=0;k<n;k++){const a=(deg+360*k/n+u(-12,12))*Math.PI/180,rr=r*u(0.78,1.08);p.push([cx+rr*Math.cos(a),cy+rr*Math.sin(a)]);}
 const w=s.shape(p,{fill,sw,amp:r>14?0.3:0.12,step:r>14?3:2});
 if(crack){const a=u(0,6.28);s.line([cx+r*0.7*Math.cos(a),cy+r*0.7*Math.sin(a)],[cx+r*0.05*Math.cos(a+1),cy+r*0.05*Math.sin(a+1)],TEX,0.15,u(-1,1));}return w;}
function block(s,cx,cy,w,h,deg,o={}){const{fill=PAPER,seam=false}=o,u=(a,b)=>s.pen.u(a,b),c=Math.min(w,h)*0.18;
 const p=rot([[cx-w/2+c,cy-h/2],[cx+w/2-c*0.4,cy-h/2+u(0,2)],[cx+w/2,cy-h/2+c],[cx+w/2-u(0,2),cy+h/2-c*0.5],[cx+w/2-c,cy+h/2],[cx-w/2+c*0.3,cy+h/2-u(0,2)],[cx-w/2,cy+h/2-c],[cx-w/2+u(0,2),cy-h/2+c*0.6]],cx,cy,deg);
 const[b,out]=s.fo(p,{fill,amp:0.35,step:4});
 if(seam)s.seam(...rot([[cx-w,cy+u(-3,3)],[cx+w,cy+u(-3,3)]],cx,cy,deg+90),b);
 const a=rot([[cx-w*0.25,cy-h*0.15],[cx+w*0.05,cy+h*0.2]],cx,cy,deg);s.line(a[0],a[1],TEX,0.15,u(-1,1));
 out();}
function bone(s,p0,p1,half,fill=PAPER){const dx=p1[0]-p0[0],dy=p1[1]-p0[1],l=Math.hypot(dx,dy),nx=-dy/l*half*0.95,ny=dx/l*half*0.95,r=half*1.25;
 for(const e of[p0,p1])for(const sg of[-1,1])s.shape(circ(e[0]+nx*sg,e[1]+ny*sg,r,12),{fill,sw:DET,amp:0.05,step:1.5});
 s.shape(band(seg2(p0,p1,6),half),{fill,sw:DET,amp:0.08,step:2});}
function skull(s,cx,cy,deg,k=1){const[M,M1]=mk(cx,cy,deg);
 s.shape(M([[0,-13],[8,-11],[11.5,-3],[11,5],[7,11],[0,13],[-7,11],[-11,5],[-11.5,-3],[-8,-11]].map(([x,y])=>[x*k,y*k])),{amp:0.12,step:2});
 for(const sx of[-1,1]){const p=M([[sx*2*k,5*k],[sx*6.5*k,4.5*k],[sx*6*k,8*k],[sx*2.5*k,8.5*k]]);s.poly(p,INK);}
}
function link(s,cx,cy,deg,flat){const[M]=mk(cx,cy,deg);
 if(flat){s.shape(M(rrect(-5,-3.2,10,6.4,3.2)),{fill:SHADE,sw:DET,amp:0.03,step:1.2});s.poly(M([[-2.2,-0.8],[2.2,-0.8],[2.2,0.8],[-2.2,0.8]]),INK);}
 else s.shape(M(rrect(-5,-1.8,10,3.6,1.8)),{fill:SHADE,sw:DET,amp:0.03,step:1.2});}
function chain(s,pts){for(let i=0;i<pts.length-1;i++){const a=pts[i],b=pts[i+1];const deg=Math.atan2(b[1]-a[1],b[0]-a[0])*180/Math.PI;link(s,(a[0]+b[0])/2,(a[1]+b[1])/2,deg,i%2===0);}}
function cuff(s,cx,cy,deg){const[M]=mk(cx,cy,deg);s.shape(M(ell(0,0,9,7)),{fill:SHADE,sw:DET,amp:0.05,step:1.5});s.shape(M(ell(0,0.5,4.8,3)),{fill:INK,sw:DET,amp:0.03,step:1.2});}
const K={};
K['pillar-broken']=()=>{const s=new Sheet(1,1,71);
 s.shape(rrect(10,10,48,48,3),{fill:SHADE});
 const[st,out]=s.fo(circ(34,34,18),{amp:0.3,step:3});s.line([24,30],[36,36],TEX,0.15,-0.8);s.line([38,26],[44,40],TEX,0.15,0.6);out();
 const[M]=mk(66,66,-38);
 const[d,dout]=s.fo(M(rrect(-15,-18,30,36,2)),{amp:0.3,step:3});
 for(const x of[-7.5,0,7.5])s.line(M([[x,-17.5]])[0],M([[x,17.5]])[0],DET,0.15);dout();
 stone(s,24,78,10,{n:6});stone(s,86,36,6,{n:6,sw:DET});stone(s,46,90,5,{n:5,sw:DET});
 return s;};
K['rubble']=()=>{const s=new Sheet(1,1,72);
 stone(s,44,52,16,{crack:true});stone(s,64,40,12);stone(s,62,64,11,{fill:SHADE});stone(s,32,70,9);stone(s,76,58,7,{sw:DET});stone(s,28,40,6,{sw:DET});stone(s,50,78,5,{sw:DET});
 return s;};
K['rubble-large']=()=>{const s=new Sheet(2,2,73),u=(a,b)=>s.pen.u(a,b);
 s.shape([[40,30],[96,20],[150,34],[180,78],[176,136],[148,176],[92,184],[42,164],[18,112],[22,60]],{fill:SHADE,amp:1.2,step:5});
 s.line([36,120],[50,134],TEX,0.2,0.8);s.line([150,150],[162,138],TEX,0.2,-0.6);
 block(s,78,74,60,38,-14,{seam:true});block(s,136,110,48,34,22);block(s,82,134,42,30,8);
 for(const[x,y,r]of[[132,58,11],[44,108,10],[160,70,7],[120,152,8],[50,56,7],[112,98,6],[58,150,6]])stone(s,x+u(-1,1),y+u(-1,1),r,{sw:r>9?OUT:DET});
 for(const[x,y]of[[22,40],[186,104],[176,172],[26,176],[100,14]])stone(s,x,y,4.5,{n:5,sw:DET});
 return s;};
K['pit']=()=>{const s=new Sheet(1,1,74),u=(a,b)=>s.pen.u(a,b),o=[],i=[];
 for(let k=0;k<11;k++){const a=6.2832*k/11+u(-.15,.15);o.push([50+40*u(0.9,1.05)*Math.cos(a),50+40*u(0.9,1.05)*Math.sin(a)]);}
 for(let k=0;k<9;k++){const a=6.2832*k/9+u(-.2,.2)+0.3;i.push([50+27*u(0.82,1.08)*Math.cos(a),50+27*u(0.82,1.08)*Math.sin(a)]);}
 const[r,out]=s.fo(o,{amp:0.3,step:4});
 s.line([12,52],[22,55],TEX,0.15,0.5);s.line([66,14],[62,22],TEX,0.15,-0.5);s.line([76,80],[70,74],TEX,0.15,0.4);
 out();s.shape(i,{fill:INK,sw:DET,amp:0.25,step:3});
 return s;};
K['spike-trap']=()=>{const s=new Sheet(1,1,75);
 s.shape(rrect(14,14,72,72,3),{fill:SHADE});
 for(let r=0;r<4;r++)for(let c=0;c<4;c++){const x=25.5+c*16.3,y=25.5+r*16.3;s.shape([[x,y-6],[x+5,y],[x,y+6],[x-5,y]],{sw:DET,amp:0.05,step:1.5});}
 return s;};
K['pressure-plate']=()=>{const s=new Sheet(1,1,76);
 s.shape(rrect(21,21,58,58,3),{fill:INK,sw:DET,amp:0.2,step:3});
 const[p,out]=s.fo(rrect(24.5,24.5,51,51,2),{amp:0.2,step:3,sw:DET});
 s.shape(rrect(31,31,38,38,1.5),{fill:NONE,sw:TEX,amp:0.15,step:3});
 s.line([36,58],[46,52],TEX,0.1,0.5);out();
 return s;};
K['well']=()=>{const s=new Sheet(2,2,77),u=(a,b)=>s.pen.u(a,b);
 const[w,out]=s.fo(circ(100,100,60),{amp:0.5});
 for(let k=0;k<9;k++){const a=6.2832*(k+u(-.2,.2))/9+0.25;s.line([100+38*Math.cos(a),100+38*Math.sin(a)],[100+60*Math.cos(a),100+60*Math.sin(a)],DET,0.2);}
 out();
 s.shape(circ(100,100,38),{fill:INK,sw:DET,amp:0.3});
 for(const x of[32,168])s.shape(rrect(x-8,92,16,16,3),{fill:SHADE});
 s.shape(band(seg2([36,100],[164,100],12),4.2),{sw:DET,amp:0.12,step:2.5});
 s.shape(rrect(90,94.5,20,11,2),{fill:SHADE,sw:DET,amp:0.08,step:2});
 s.shape(band([[172,100],[184,100],[184,116]],2.6),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 s.shape(rrect(180,114,8,10,3),{sw:DET,amp:0.05,step:1.5});
 const[M]=mk(144,168,20);
 s.shape(M(band([[-9,-8],[-3,-12.5],[3,-12.5],[9,-8]],1.8)),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 s.shape(circ(144,168,11),{sw:DET,amp:0.1,step:2});s.shape(circ(144.3,168.3,7.2),{fill:SHADE,sw:DET,amp:0.08,step:1.8});
 return s;};
K['cage']=()=>{const s=new Sheet(1,1,78);
 const[f,out]=s.fo(rrect(14,14,72,72,4),{fill:SHADE});
 s.shape(rrect(21,21,58,58,2),{sw:DET,amp:0.25,step:3});
 for(const x of[33,44.5,55.5,67])s.shape(band(seg2([x,20],[x,80],8),2.3),{fill:SHADE,sw:DET,amp:0.08,step:2});
 s.shape(band(seg2([20,50],[80,50],8),2.3),{fill:SHADE,sw:DET,amp:0.08,step:2});
 for(const[x,y]of[[17.5,17.5],[82.5,17.5],[82.5,82.5],[17.5,82.5]])s.dot(x,y,1.4);
 out();
 s.shape(rrect(43,79,14,12,2.5),{fill:SHADE,sw:DET,amp:0.2,step:2});s.dot(50,83.5,1.9);s.poly([[49,84.5],[51,84.5],[51.7,88],[48.3,88]],INK);
 return s;};
K['stocks']=()=>{const s=new Sheet(1,1,79),R=p=>rot(p,50,50,2);
 for(const x of[14,74])s.shape(R(rrect(x,24,12,52,3)),{fill:SHADE});
 const[seat,sout]=s.fo(R(rrect(26,18,48,16,5)),{amp:0.3,step:3});s.grain(...R([[34,26],[50,26.5]]));sout();
 const[b,out]=s.fo(R(rrect(10,46,80,16,3)),{amp:0.35,step:3});
 s.line(...R([[10.5,54],[89.5,54.4]]),DET,0.2);
 for(const x of[34,66]){const p=R([[x,54]])[0];s.dot(p[0],p[1],1.5);}
 out();
 s.shape(R(rrect(80,48,9,12,2)),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 for(const x of[14,74])s.shape(R(rrect(x+2,49,8,10,2)),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 return s;};
K['rack']=()=>{const s=new Sheet(1,2,80);
 s.shape(rrect(29,40,42,120,2),{fill:SHADE,sw:DET,amp:0.3});
 for(const[x,a,b]of[[38,54,72],[60,70,88],[42,112,130],[58,130,148]])s.grain([x,a],[x+0.5,b]);
 for(const x of[24,76])s.shape(band(seg2([x,14],[x,186],12),5.5),{amp:0.3,step:3});
 for(const y of[30,170]){s.shape(band(seg2([17,y],[83,y],8),7),{amp:0.2,step:3});for(const x of[38,62])s.shape(rrect(x-5,y-7.5,10,15,3),{fill:SHADE,sw:DET,amp:0.05,step:1.5});}
 for(const[x,y0,y1]of[[38,38,70],[62,38,70],[38,130,162],[62,130,162]])s.line([x,y0],[x+(x<50?2:-2),y1],DET,0.15);
 for(const[x,y]of[[40,76],[60,76],[40,124],[60,124]]){s.shape(rrect(x-4.5,y-6,9,12,2.5),{fill:SHADE,sw:DET,amp:0.05,step:1.5});s.poly([[x-1,y-3],[x+1,y-3],[x+1,y+3],[x-1,y+3]],INK);}
 s.shape(band([[83,30],[89,30]],2.8),{fill:SHADE,sw:DET,amp:0.03,step:1.2});s.shape(band(seg2([89,14],[89,46],4),2.6),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 s.shape(band([[17,170],[11,170]],2.8),{fill:SHADE,sw:DET,amp:0.03,step:1.2});s.shape(band(seg2([11,154],[11,186],4),2.6),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 return s;};
K['shackles']=()=>{const s=new Sheet(1,1,81);
 for(const x of[28,72]){s.shape(rrect(x-8,8,16,11,2.5),{fill:SHADE,sw:DET,amp:0.05,step:1.5});s.dot(x-4.5,13.5,1.2);s.dot(x+4.5,13.5,1.2);}
 chain(s,[[28,19],[27,27],[25,35],[24,43],[25,51],[28,58]]);cuff(s,30,66,70);
 chain(s,[[72,19],[74,27],[76,35],[76,43],[73,50],[68,56],[62,60]]);cuff(s,54,64,-20);
 return s;};
K['lever']=()=>{const s=new Sheet(1,1,82);
 s.shape(rrect(30,8,40,22,3),{fill:SHADE});
 s.shape(rrect(46,12,8,15,2),{fill:INK,sw:DET,amp:0.05,step:1.5});
 s.shape(band(seg2([50,20],[56,64],8),3.4),{sw:DET,amp:0.08,step:2});
 s.shape(circ(57,69,7.5),{sw:DET,amp:0.1,step:2});
 for(const x of[35,65])s.dot(x,14,1.3);
 return s;};
K['trapdoor']=()=>{const s=new Sheet(1,1,83),u=(a,b)=>s.pen.u(a,b);
 s.shape(rrect(14,14,72,72,3),{fill:SHADE});
 const[d,out]=s.fo(rrect(21,21,58,58,2),{amp:0.3,step:3});
 for(const x of[35.5,50,64.5])s.seam([x+u(-.4,.4),10],[x+u(-.4,.4),90],d);
 for(const[x,a,b]of[[28,40,56],[43,62,76],[57,42,58],[72,58,74]])s.grain([x,a],[x+u(-.5,.5),b]);
 for(const y of[26,72]){s.shape(band(seg2([22,y],[58,y],6),3),{fill:SHADE,sw:DET,amp:0.08,step:2});s.dot(26,y,1.2);s.dot(52,y,1.2);}
 out();
 s.shape(circ(69,50,8),{fill:SHADE,sw:DET,amp:0.08,step:1.8});s.shape(circ(69,50,4.3,10),{sw:DET,amp:0.04,step:1.3});
 return s;};
K['ladder']=()=>{const s=new Sheet(1,1,84);
 s.shape(rrect(14,12,72,76,3),{fill:SHADE});s.line([20,74],[26,82],TEX,0.1,0.4);
 s.shape(rrect(22,20,56,60,2),{fill:INK,sw:DET,amp:0.2,step:3});
 for(const y of[30,44,56,66,74])s.shape(band(seg2([36,y],[64,y],4),2.4),{sw:DET,amp:0.05,step:1.5});
 for(const x of[36,64])s.shape(band(seg2([x,12],[x,76],8),3),{sw:DET,amp:0.08,step:2});
 return s;};
K['stairs-spiral']=()=>{const s=new Sheet(2,2,85),C=100,R=72,u=(a,b)=>s.pen.u(a,b);
 const[wall,wout]=s.fo(circ(C,C,88),{amp:0.6});
 for(let k=0;k<8;k++){const a=6.2832*(k+u(-.2,.2))/8+0.4;s.line([C+R*Math.cos(a),C+R*Math.sin(a)],[C+88*Math.cos(a),C+88*Math.sin(a)],DET,0.2);}
 wout();
 s.shape(circ(C,C,R),{fill:INK,sw:DET,amp:0.4});
 const n=12,w=28,a0=90;for(let k=0;k<11;k++){const A=(a0+k*w)*Math.PI/180,B=(a0+(k+1)*w)*Math.PI/180,p=[];
  for(let t=0;t<=6;t++){const a=A+(B-A)*t/6;p.push([C+R*Math.cos(a),C+R*Math.sin(a)]);}
  for(let t=6;t>=0;t--){const a=A+(B-A)*t/6;p.push([C+12*Math.cos(a),C+12*Math.sin(a)]);}
  s.shape(p,{fill:k<6?PAPER:SHADE,sw:DET,amp:0.2,step:3});}
 s.shape(circ(C,C,R),{fill:NONE,sw:DET,amp:0.3});
 s.shape(circ(C,C,14),{amp:0.2,step:2.5});
 return s;};
K['bones']=()=>{const s=new Sheet(1,1,86);
 skull(s,34,34,-20,1.05);bone(s,[56,30],[84,44],2.6);bone(s,[22,66],[50,78],2.6);bone(s,[62,60],[70,86],2.2);bone(s,[74,64],[86,72],1.8);
 stone(s,48,56,3.5,{n:5,sw:DET});stone(s,16,48,3,{n:5,sw:DET});
 return s;};
K['skeleton']=()=>{const s=new Sheet(1,2,87),R=p=>rot(p,50,100,3),R1=p=>R([p])[0];
 for(const[a,b,h]of[[[34,48],[26,84],2.8],[[26,86],[24,118],2.3],[[66,48],[74,82],2.8],[[74,84],[80,114],2.3],[[42,122],[38,156],3.1],[[38,158],[36,184],2.5],[[58,122],[64,154],3.1],[[64,156],[68,182],2.5]])bone(s,R1(a),R1(b),h);
 for(const[x,y]of[[23,124],[82,120],[34,188],[70,188]])stone(s,...R1([x,y]),4,{n:5,sw:DET});
 s.shape(R([[50,44],[64,48],[66,64],[62,80],[50,86],[38,80],[34,64],[36,48]]),{fill:SHADE,sw:DET,amp:0.2,step:2.5});
 for(const[y,d]of[[54,0],[64,1],[74,2]]){s.stroke(R([[48,y],[58,y-1+d*0.5],[63,y+3]]),DET,0.05,2);s.stroke(R([[52,y+1],[42,y+d*0.6],[37,y+4]]),DET,0.05,2);}
 s.shape(R(band(seg2([50,40],[50,108],10),2.6)),{sw:DET,amp:0.05,step:1.5});
 s.shape(R([[38,106],[50,102],[62,106],[64,116],[56,124],[50,120],[44,124],[36,116]]),{sw:DET,amp:0.1,step:2});
 s.poly(R([[42,112],[46,111],[46,115],[42,116]]),INK);s.poly(R([[54,111],[58,112],[58,116],[54,115]]),INK);
 s.shape(R(band(seg2([36,46],[64,46],4),2.2)),{sw:DET,amp:0.05,step:1.5});
 skull(s,...R1([50,24]),183,1.15);
 return s;};
K['web']=()=>{const s=new Sheet(2,2,88),u=(a,b)=>s.pen.u(a,b),O=[10,10];
 const ends=[[190,14],[188,58],[176,108],[146,152],[104,180],[56,190],[14,188]].map(p=>[p[0]+u(-2,2),p[1]+u(-2,2)]);
 const rad=ends.map(e=>{const pts=seg2(O,e,10);return pts.map((p,i)=>[p[0]+u(-.8,.8)*(i>0),p[1]+u(-.8,.8)*(i>0)]);});
 for(const r of rad)s.stroke(r,DET,0.2,6);
 for(const t of[0.14,0.26,0.39,0.53,0.68,0.84])for(let i=0;i<rad.length-1;i++){if(u(0,1)<0.1)continue;
  const at=r=>{const idx=Math.min(9,Math.round(t*10+u(-.3,.3)));return r[idx];};const a=at(rad[i]),b=at(rad[i+1]);
  s.line(a,b,TEX,0.1,-L(a,b)*0.12);}
 const[M]=mk(118,112,-40);s.shape(M(ell(0,0,15,9)),{sw:DET,amp:0.15,step:2});
 for(const x of[-6,2,9])s.line(M([[x-3,-7.5]])[0],M([[x+2,7.5]])[0],TEX,0.05);
 return s;};

const KMETA=[
 ['pillar-broken','Broken Pillar',1,1,['pillar','column','broken','ruin','stone','dungeon'],'movement'],
 ['rubble','Rubble',1,1,['rubble','stones','debris','ruin','dungeon','cave'],'movement'],
 ['rubble-large','Collapsed Ceiling',2,2,['rubble','collapse','debris','blocks','ruin','dungeon','cave'],'sight'],
 ['pit','Open Pit',1,1,['pit','hole','trap','hazard','dungeon','cave'],'movement'],
 ['spike-trap','Spike Trap',1,1,['spikes','trap','hazard','floor','dungeon','iron'],'none'],
 ['pressure-plate','Pressure Plate',1,1,['pressure','plate','trap','trigger','floor','dungeon'],'none'],
 ['well','Stone Well',2,2,['well','water','bucket','crank','stone','village','courtyard'],'movement'],
 ['cage','Iron Cage',1,1,['cage','iron','prison','bars','dungeon','captive'],'movement'],
 ['stocks','Wooden Stocks',1,1,['stocks','punishment','prison','wood','dungeon','town'],'movement'],
 ['rack','Torture Rack',1,2,['rack','torture','rollers','prison','dungeon','wood'],'movement'],
 ['shackles','Wall Shackles',1,1,['shackles','chains','prison','wall','dungeon','iron'],'none'],
 ['lever','Wall Lever',1,1,['lever','switch','mechanism','wall','dungeon','iron'],'none'],
 ['trapdoor','Trapdoor',1,1,['trapdoor','hatch','door','floor','wood','cellar','dungeon'],'none'],
 ['ladder','Ladder Down',1,1,['ladder','hole','down','exit','dungeon','cellar'],'movement'],
 ['stairs-spiral','Spiral Staircase',2,2,['stairs','spiral','down','tower','stone','dungeon'],'movement'],
 ['bones','Scattered Bones',1,1,['bones','skull','remains','dead','dungeon','lair'],'none'],
 ['skeleton','Skeleton',1,2,['skeleton','remains','bones','dead','dungeon','crypt'],'none'],
 ['web','Spider Web',2,2,['web','spider','cobweb','corner','dungeon','cave','lair'],'movement']];
const kin={},krep={};
for(const[id,,w,h]of KMETA){const s=K[id]();if(s.W!==w*100||s.H!==h*100)throw id+' size';const svg=s.svg();krep[id]=s.bad.length?s.bad.slice(0,3):0;
 const cols=[...new Set(svg.match(/#[0-9A-Fa-f]{6}/g))].filter(c=>![INK,PAPER,SHADE].includes(c));if(cols.length)krep[id]={cols};
 await saveFile(`dungeon/${id}.svg`,svg);kin[id]=s.els;}
{let x=100;const H=Math.max(...KMETA.map(m=>m[3]));const CH=(H+2)*100,base=(H+1)*100;const W=100+KMETA.reduce((a,m)=>a+(m[2]+1)*100,0);
 let grid='';for(let gx=100;gx<W;gx+=100)grid+=`M${gx} 0V${CH}`;for(let gy=100;gy<CH;gy+=100)grid+=`M0 ${gy}H${W}`;
 let card=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${CH}" viewBox="0 0 ${W} ${CH}">\n  <rect width="${W}" height="${CH}" fill="#F0ECE0"/>\n  <path d="${grid}" fill="none" stroke="#DDD6C3" stroke-width="1.5"/>\n`;
 for(const[id,,w,h]of KMETA){card+=`  <svg x="${x}" y="${base-h*100}" width="${w*100}" height="${h*100}" viewBox="0 0 ${w*100} ${h*100}">\n`+kin[id].map(e=>'  '+e).join('\n')+`\n  </svg>\n  <text x="${x+w*50}" y="${base+36}" text-anchor="middle" font-family="ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="20" fill="#4A4336">${id}</text>\n`;x+=(w+1)*100;}
 await saveFile('overview/dungeon.svg',card+'</svg>\n');}
const kman=JSON.parse(await readFile('manifest.json')).filter(e=>e.category!=='dungeon');
const kall=[...kman,...KMETA.map(([id,name,w,h,tags,blocks])=>({id,name,category:'dungeon',w,h,tags,blocks}))];
const kids=kall.map(e=>e.id);if(new Set(kids).size!==kids.length)throw 'duplicate id';
await saveFile('manifest.json','[\n'+kall.map(e=>'  '+JSON.stringify(e).replace(/,"/g,', "').replace(/":/g,'": ')).join(',\n')+'\n]\n');
log(JSON.stringify(krep));
