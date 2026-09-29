// Workshop + light batch. Run after furniture/storage/temple/dungeon helper blocks.
function flame(s,cx,cy,r,ph=0){const p=[];for(let k=0;k<30;k++){const t=6.2832*k/30;const rr=r*(1+0.24*Math.cos(3*t+ph));p.push([cx+rr*Math.cos(t),cy+rr*Math.sin(t)]);}s.shape(p,{sw:DET,amp:0.08,step:1.8});}
function ring(s,cx,cy,R,n,r){const u=(a,b)=>s.pen.u(a,b);for(let k=0;k<n;k++){const a=6.2832*(k+u(-.12,.12))/n;stone(s,cx+R*Math.cos(a),cy+R*Math.sin(a),r*u(0.85,1.1),{n:6,deg:u(0,60),sw:r>8?OUT:DET});}}
function pot(s,x,y,r){s.shape(band([[x-r*0.95,y],[x-r*0.6,y-r*0.9],[x,y-r*1.15],[x+r*0.6,y-r*0.9],[x+r*0.95,y]],1.8),{fill:SHADE,sw:DET,amp:0.03,step:1.3});
 s.shape(circ(x,y,r),{fill:SHADE,amp:0.2,step:2.5});s.shape(circ(x,y,r*0.74),{sw:DET,amp:0.1,step:2});s.shape(circ(x+0.3,y+0.3,r*0.5),{fill:SHADE,sw:DET,amp:0.08,step:1.8});}
function keg(s,cx,cy,deg,k){const[M,M1]=mk(cx,cy,deg),h=x=>(28-5*(x/44)**2)*k,top=[],bot=[];
 for(let x=-44;x<=44;x+=4){top.push([x*k,-h(x)]);bot.unshift([x*k,h(x)]);}
 const[b,out]=s.fo(M([...top,...bot]),{amp:0.3,step:3});
 for(const f of[-0.45,0.45]){const pts=[];for(let x=-40;x<=40;x+=8)pts.push([x*k,f*h(x)]);s.stroke(M(pts),TEX,0.15,5);}
 for(const a of[-30,30]){const x0=(a-3)*k,x1=(a+3)*k;s.shape(M([[x0,-h(a-3)-0.5],[x1,-h(a+3)-0.5],[x1,h(a+3)+0.5],[x0,h(a-3)+0.5]]),{fill:SHADE,sw:DET,amp:0.1,step:2});}
 out();}
const W={};
W['cooking-fire']=()=>{const s=new Sheet(2,2,91);
 s.shape(ell(100,100,36,31),{fill:SHADE,sw:DET,amp:0.8,step:3});
 s.shape(band(seg2([70,114],[102,122],6),5.5),{amp:0.2,step:3});s.shape(band(seg2([96,80],[128,92],6),5.5),{amp:0.2,step:3});
 flame(s,82,96,8,0.5);flame(s,120,110,8,1.2);flame(s,100,122,6,2);
 ring(s,100,100,46,12,9.5);
 for(const x of[30,170])s.shape(rrect(x-7,93,14,14,3),{fill:SHADE});
 s.shape(band(seg2([34,100],[166,100],12),3),{sw:DET,amp:0.08,step:2});
 const[r,rout]=s.fo(ell(100,100,19,11),{amp:0.2,step:2.5});s.line([92,90],[91,110],TEX,0.05,0.8);s.line([108,90],[109,110],TEX,0.05,-0.8);rout();
 s.shape(band([[170,100],[182,100],[182,112]],2.6),{fill:SHADE,sw:DET,amp:0.03,step:1.3});s.shape(rrect(178,110,8,10,3),{sw:DET,amp:0.03,step:1.3});
 pot(s,152,166,15);return s;};
W['cauldron']=()=>{const s=new Sheet(1,1,92);
 for(const sx of[-1,1]){const ex=50+sx*38;s.shape([[ex-sx*3,44],[ex+sx*7,45],[ex+sx*7,55],[ex-sx*3,56]],{fill:SHADE,sw:DET,amp:0.08,step:2});s.poly([[ex+sx*3.5-1,47],[ex+sx*3.5+1,47],[ex+sx*3.5+1,53],[ex+sx*3.5-1,53]],INK);}
 s.shape(circ(50,50,38),{fill:SHADE,amp:0.4,step:3});s.shape(circ(50,50,31),{sw:DET,amp:0.25,step:2.5});s.shape(circ(50.5,50.5,25.5),{fill:SHADE,sw:DET,amp:0.25,step:2.5});
 s.shape(circ(42,44,5.5,14),{sw:DET,amp:0.05,step:1.5});s.shape(circ(58,56,4,12),{sw:DET,amp:0.05,step:1.5});s.shape(circ(51,40,2.8,10),{sw:DET,amp:0.03,step:1.2});s.shape(circ(40,58,2.6,10),{sw:DET,amp:0.03,step:1.2});
 return s;};
W['oven']=()=>{const s=new Sheet(2,1,93);
 s.shape(rrect(66,62,68,28,3),{fill:SHADE});s.line([72,84],[82,86],TEX,0.1,0.4);
 const dome=[[22,8],[178,8]];for(let k=0;k<=18;k++){const a=Math.PI*k/18;dome.push([100+78*Math.cos(a),40+34*Math.sin(a)]);}dome.push([22,8]);
 const[d,out]=s.fo(dome.slice(0,-1),{amp:0.5,step:4});
 for(const[rx,ry]of[[62,22],[44,11]]){const p=[];for(let k=0;k<=14;k++){const a=Math.PI*k/14;p.push([100+rx*Math.cos(a),40+ry*Math.sin(a)]);}p.unshift([100+rx,12]);p.push([100-rx,12]);s.stroke(p,DET,0.3,5);}
 for(const[x,y0,y1]of[[40,14,26],[160,16,28],[62,52,60],[138,52,60],[30,36,44],[170,34,44]])s.line([x,y0],[x+1,y1],TEX,0.1);
 s.shape(rrect(90,16,20,14,2),{fill:SHADE,sw:DET,amp:0.1,step:2});
 out();s.shape(ell(100,72,17,8.5),{fill:INK,sw:DET,amp:0.15,step:2});return s;};
W['anvil']=()=>{const s=new Sheet(1,1,94);
 const[st,out]=s.fo(circ(50,50,36),{amp:0.5});s.line([24,34],[32,40],TEX,0.1,0.5);s.line([66,74],[76,70],TEX,0.1,-0.5);s.line([30,66],[40,72],TEX,0.1,0.4);out();
 s.shape([[18,48],[30,43],[40,41],[64,41],[64,37],[80,37],[80,59],[64,59],[64,55],[40,55],[30,53]],{fill:SHADE,amp:0.25,step:2.5});
 s.poly([[68,45],[72,45],[72,49],[68,49]],INK);
 s.shape(band(seg2([36,74],[58,82],4),2.2),{sw:DET,amp:0.05,step:1.5});s.shape(rot(rrect(28,64,8,17,2),32,72.5,20),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 return s;};
W['forge']=()=>{const s=new Sheet(2,2,95);
 const[h,out]=s.fo(rrect(22,30,156,104,4));
 for(const[a,b]of[[[22.5,96],[60,96.5]],[[140,98],[177.5,98.5]],[[60,96],[60.5,133.5]],[[140,98],[139.5,133.5]],[[96,110],[96.5,133.5]]])s.line(a,b,DET,0.3);
 s.line([34,118],[44,124],TEX,0.1,0.4);s.line([156,112],[166,120],TEX,0.1,-0.4);
 out();
 s.shape([[66,58],[100,52],[134,58],[140,78],[130,96],[100,102],[70,96],[60,78]],{fill:SHADE,sw:DET,amp:0.4,step:3});
 flame(s,90,76,8,0.3);flame(s,112,84,7,1.4);
 s.shape(rrect(14,8,172,32,4),{fill:SHADE});s.shape(rrect(82,12,36,22,2),{sw:DET,amp:0.15,step:2.5});
 const[M,M1]=mk(154,164,-35);
 s.shape(M(band(seg2([0,-24],[0,-38],3),2.6)),{fill:SHADE,sw:DET,amp:0.03,step:1.3});
 const[b,bout]=s.fo(M([[0,-26],[10,-14],[15,0],[14,12],[8,20],[0,22],[-8,20],[-14,12],[-15,0],[-10,-14]]),{amp:0.25,step:3});s.line(M1([0,-18]),M1([0,14]),TEX,0.05);bout();
 s.shape(M(band(seg2([-7,24],[7,24],3),2.6)),{sw:DET,amp:0.03,step:1.3});
 return s;};
W['workbench']=()=>{const s=new Sheet(2,1,96),u=(a,b)=>s.pen.u(a,b);
 s.shape(band(seg2([18,90],[48,90],4),2.4),{sw:DET,amp:0.05,step:1.5});
 const[t,out]=s.fo(rrect(10,20,180,58,3));
 for(const y of[38.5,57.5])s.seam([4,y+u(-.4,.4)],[196,y+u(-.4,.4)],t);
 for(const[a,b,y]of[[24,44,29],[150,170,28],[30,50,67],[112,132,68]])s.grain([a,y],[b,y+u(-.5,.5)]);
 out();
 s.shape(rrect(20,74,28,12,2),{fill:SHADE,sw:DET,amp:0.1,step:2});
 const[M]=mk(140,46,-6,140,46);
 s.shape(M([[112,40],[160,38],[160,52],[112,48]]),{fill:SHADE,sw:DET,amp:0.1,step:2.5});
 s.shape(M(rrect(160,34,16,22,4)),{sw:DET,amp:0.1,step:2});s.poly(M([[165,40],[171,40],[171,50],[165,50]]),INK);
 s.shape(band(seg2([56,58],[82,40],4),2.3),{sw:DET,amp:0.05,step:1.5});s.shape(rot(rrect(80,30,8,18,2),84,39,-56),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 s.shape(band(seg2([96,66],[110,65],3),2.8),{sw:DET,amp:0.03,step:1.3});s.shape(band(seg2([110,65],[122,64.5],3),1.8),{fill:SHADE,sw:DET,amp:0.03,step:1.3});
 return s;};
W['alchemy-table']=()=>{const s=new Sheet(2,1,97),u=(a,b)=>s.pen.u(a,b);
 const[t,out]=s.fo(rrect(10,16,180,64,3));
 for(const y of[37.5,58.5])s.seam([4,y+u(-.4,.4)],[196,y+u(-.4,.4)],t);
 s.grain([150,26],[170,26.5]);s.grain([30,70],[48,70.5]);out();
 s.shape([[132,66],[146,62],[156,68],[150,76],[136,75]],{fill:SHADE,sw:DET,amp:0.3,step:2.5});
 s.shape(band(seg2([58,42],[86,31],4),2.2),{sw:DET,amp:0.05,step:1.5});
 s.shape(circ(48,46,13),{sw:DET,amp:0.12,step:2});s.shape(circ(48.5,46.5,7.5),{fill:SHADE,sw:DET,amp:0.08,step:1.8});
 s.shape(circ(92,29,7),{sw:DET,amp:0.08,step:1.8});
 s.shape(circ(114,36,6.5),{sw:DET,amp:0.06,step:1.6});s.shape(circ(126,48,5),{sw:DET,amp:0.05,step:1.5});
 s.shape(band(seg2([130,62],[118,60],3),2),{sw:DET,amp:0.03,step:1.3});s.shape(circ(124,62,6.5),{sw:DET,amp:0.06,step:1.6});
 s.shape(circ(166,44,11),{sw:DET,amp:0.1,step:2});s.shape(circ(166.3,44.3,6.5),{fill:SHADE,sw:DET,amp:0.06,step:1.6});
 s.shape(band(seg2([162,64],[182,68],4),2.8),{sw:DET,amp:0.05,step:1.5});
 stub(s,28,62,6);return s;};
W['loom']=()=>{const s=new Sheet(2,1,98);
 for(const x of[18,182])s.shape(band(seg2([x,12],[x,84],8),6),{fill:SHADE,amp:0.25,step:3});
 s.shape(rrect(28,24,144,28,1.5),{fill:SHADE,sw:DET,amp:0.25});for(const x of[50,86,120,154])s.line([x,27],[x+0.5,49],TEX,0.1);
 s.shape(rrect(28,50,144,22,1.5),{sw:DET,amp:0.25});s.line([34,60],[92,60.5],TEX,0.1,0.5);s.line([108,66],[166,65.5],TEX,0.1,-0.5);
 s.shape(band(seg2([22,50],[178,50],10),3.2),{sw:DET,amp:0.1,step:2.5});
 for(const y of[19,78])s.shape(band(seg2([14,y],[186,y],12),5.5),{amp:0.3,step:3});
 s.shape([[70,62],[80,59.5],[92,62],[80,64.5]],{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 s.shape(rrect(70,86,60,7.5,3),{sw:DET,amp:0.1,step:2});return s;};
W['grindstone']=()=>{const s=new Sheet(1,1,99);
 for(const x of[24,76])s.shape(band(seg2([x,14],[x,86],8),5),{fill:SHADE,amp:0.2,step:2.5});
 s.shape(band(seg2([18,50],[86,50],6),3),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 const[w,out]=s.fo(rrect(36,20,28,60,8),{amp:0.25,step:3});s.line([44,30],[45,44],TEX,0.05,0.4);s.line([55,56],[56,70],TEX,0.05,-0.4);out();
 s.shape(band(seg2([86,50],[86,64],3),2.5),{fill:SHADE,sw:DET,amp:0.03,step:1.3});s.shape(rrect(82,62,8,10,3),{sw:DET,amp:0.03,step:1.3});
 return s;};
W['keg-rack']=()=>{const s=new Sheet(2,1,100);
 for(const x of[15,185])s.shape(rrect(x-6,16,12,56,3),{fill:SHADE});
 for(const y of[28,62])s.shape(band(seg2([16,y],[184,y],12),4),{fill:SHADE,sw:DET,amp:0.15,step:3});
 for(const x of[36,78.5,121.5,164]){s.shape(band(seg2([x,70],[x,80],2),2.2),{fill:SHADE,sw:DET,amp:0.03,step:1.3});s.shape(rrect(x-4,78,8,6,2),{sw:DET,amp:0.03,step:1.2});keg(s,x,44,90,0.6);}
 return s;};
W['sconce']=()=>{const s=new Sheet(1,1,101);
 s.shape(rrect(38,8,24,14,3),{fill:SHADE,sw:DET,amp:0.08,step:2});s.dot(43,15,1.2);s.dot(57,15,1.2);
 s.shape(band(seg2([50,18],[50,34],3),2.6),{fill:SHADE,sw:DET,amp:0.03,step:1.3});
 s.shape(band(seg2([50,24],[51,46],4),3.6),{sw:DET,amp:0.05,step:1.5});
 s.shape(ell(51,49,7,6),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 flame(s,51,55,9,0.8);return s;};
W['brazier']=()=>{const s=new Sheet(1,1,102);
 for(const a of[30,150,270]){const r=a*Math.PI/180,x=50+38*Math.cos(r),y=50+38*Math.sin(r);s.shape(rot(rrect(x-5,y-5,10,10,2.5),x,y,a),{fill:SHADE,sw:DET,amp:0.05,step:1.5});}
 s.shape(circ(50,50,34),{fill:SHADE,amp:0.35,step:3});s.shape(circ(50,50,29),{sw:DET,amp:0.2,step:2.5});s.shape(circ(50.5,50.5,24.5),{fill:SHADE,sw:DET,amp:0.4,step:2.5});
 flame(s,44,46,10,0.2);flame(s,60,56,8,1.3);flame(s,45,62,6,2.2);return s;};
W['candles']=()=>{const s=new Sheet(1,1,103);
 s.shape([[30,36],[52,28],[74,36],[80,56],[70,74],[48,78],[28,70],[22,52]],{fill:SHADE,sw:DET,amp:1,step:3});
 s.shape(ell(80,72,5,3.5),{fill:SHADE,sw:DET,amp:0.1,step:1.5});s.shape(ell(20,40,4,3),{fill:SHADE,sw:DET,amp:0.1,step:1.5});
 for(const[x,y,r]of[[40,44,8],[58,40,6],[63,59,7.5],[43,64,5.5],[71,46,4.5]])s.shape(circ(x,y,r,16),{sw:DET,amp:0.08,step:1.6});
 return s;};
W['lantern']=()=>{const s=new Sheet(1,1,104),oct=r=>[...Array(8)].map((_,k)=>{const a=(22.5+45*k)*Math.PI/180;return[50+r*Math.cos(a),50+r*Math.sin(a)];});
 s.shape(oct(20),{fill:SHADE,amp:0.15,step:2.5});s.shape(oct(12),{sw:DET,amp:0.08,step:2});
 const arc=[];for(let a=200;a<=340;a+=14)arc.push([50+24*Math.cos(a*Math.PI/180),54+24*Math.sin(a*Math.PI/180)]);
 s.shape(band(arc,2),{fill:SHADE,sw:DET,amp:0.03,step:1.3});return s;};
W['chandelier']=()=>{const s=new Sheet(2,2,105),C=100,R=68,n=8,A=k=>(10+45*k)*Math.PI/180;
 for(let k=0;k<n;k++){const p=[];for(let t=0;t<=6;t++){const a=A(k)+(A(k+1)-A(k))*t/6;p.push([C+R*Math.cos(a),C+R*Math.sin(a)]);}s.shape(band(p,3.6),{fill:SHADE,sw:DET,amp:0.08,step:2});}
 for(let k=0;k<n;k++){const a=A(k);stub(s,C+R*Math.cos(a),C+R*Math.sin(a),9);}
 return s;};
W['campfire']=()=>{const s=new Sheet(1,1,106);
 s.shape(ell(50,52,23,20),{fill:SHADE,sw:DET,amp:0.6,step:2.5});
 s.shape(band(seg2([34,58],[56,64],5),4.5),{amp:0.15,step:2.5});s.shape(band(seg2([46,40],[66,48],5),4.5),{amp:0.15,step:2.5});
 flame(s,48,51,7,0.4);flame(s,62,60,5,1.5);
 ring(s,50,52,33,9,7.5);return s;};

const WMETA=[
 ['workshop','cooking-fire','Cooking Fire with Spit',2,2,['fire','cooking','spit','pot','camp','kitchen','stone'],'movement'],
 ['workshop','cauldron','Iron Cauldron',1,1,['cauldron','iron','potion','witch','kitchen','brew'],'movement'],
 ['workshop','oven','Brick Bread Oven',2,1,['oven','bread','brick','bakery','kitchen','wall'],'sight'],
 ['workshop','anvil','Anvil on Stump',1,1,['anvil','smithy','iron','stump','hammer','forge'],'movement'],
 ['workshop','forge','Smithy Forge',2,2,['forge','smithy','coals','bellows','hood','fire'],'sight'],
 ['workshop','workbench','Carpenter\'s Workbench',2,1,['workbench','carpenter','tools','saw','hammer','wood'],'movement'],
 ['workshop','alchemy-table','Alchemy Table',2,1,['alchemy','table','flasks','alembic','mortar','laboratory'],'movement'],
 ['workshop','loom','Weaving Loom',2,1,['loom','weaving','cloth','craft','wood','cottage'],'movement'],
 ['workshop','grindstone','Grindstone',1,1,['grindstone','sharpen','wheel','stone','smithy','crank'],'movement'],
 ['workshop','keg-rack','Keg Rack',2,1,['kegs','rack','ale','tavern','cellar','wood'],'movement'],
 ['light','sconce','Wall Sconce Torch',1,1,['sconce','torch','wall','flame','light','dungeon'],'none'],
 ['light','brazier','Iron Brazier',1,1,['brazier','fire','iron','coals','light','temple'],'movement'],
 ['light','candles','Candle Cluster',1,1,['candles','wax','cluster','light','shrine','ritual'],'none'],
 ['light','lantern','Hanging Lantern',1,1,['lantern','hanging','iron','light','street','inn'],'none'],
 ['light','chandelier','Iron Chandelier',2,2,['chandelier','candles','iron','hanging','light','hall'],'none'],
 ['light','campfire','Campfire',1,1,['campfire','fire','logs','stones','camp','light'],'movement']];
const win={},wrep={};
for(const[cat,id,,w,h]of WMETA){const s=W[id]();if(s.W!==w*100||s.H!==h*100)throw id+' size';const svg=s.svg();wrep[id]=s.bad.length?s.bad.slice(0,3):0;
 const cols=[...new Set(svg.match(/#[0-9A-Fa-f]{6}/g))].filter(c=>![INK,PAPER,SHADE].includes(c));if(cols.length)wrep[id]={cols};
 await saveFile(`${cat}/${id}.svg`,svg);win[id]=s.els;}
for(const cat of['workshop','light']){const list=WMETA.filter(m=>m[0]===cat);let x=100;const H=Math.max(...list.map(m=>m[4]));const CH=(H+2)*100,base=(H+1)*100;const Wd=100+list.reduce((a,m)=>a+(m[3]+1)*100,0);
 let grid='';for(let gx=100;gx<Wd;gx+=100)grid+=`M${gx} 0V${CH}`;for(let gy=100;gy<CH;gy+=100)grid+=`M0 ${gy}H${Wd}`;
 let card=`<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}" height="${CH}" viewBox="0 0 ${Wd} ${CH}">\n  <rect width="${Wd}" height="${CH}" fill="#F0ECE0"/>\n  <path d="${grid}" fill="none" stroke="#DDD6C3" stroke-width="1.5"/>\n`;
 for(const[,id,,w,h]of list){card+=`  <svg x="${x}" y="${base-h*100}" width="${w*100}" height="${h*100}" viewBox="0 0 ${w*100} ${h*100}">\n`+win[id].map(e=>'  '+e).join('\n')+`\n  </svg>\n  <text x="${x+w*50}" y="${base+36}" text-anchor="middle" font-family="ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="20" fill="#4A4336">${id}</text>\n`;x+=(w+1)*100;}
 await saveFile(`overview/${cat}.svg`,card+'</svg>\n');}
const wman=JSON.parse(await readFile('manifest.json')).filter(e=>e.category!=='workshop'&&e.category!=='light');
const wall=[...wman,...WMETA.map(([category,id,name,w,h,tags,blocks])=>({id,name,category,w,h,tags,blocks}))];
const wids=wall.map(e=>e.id);if(new Set(wids).size!==wids.length)throw 'duplicate id';
await saveFile('manifest.json','[\n'+wall.map(e=>'  '+JSON.stringify(e).replace(/,"/g,', "').replace(/":/g,'": ')).join(',\n')+'\n]\n');
log(JSON.stringify(wrep));
