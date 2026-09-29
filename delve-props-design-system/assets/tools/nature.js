// Nature + water batch. Run after the furniture/storage/temple/dungeon/workshop helper blocks.
function lobed(cx,cy,R,n,a,ph=0){const p=[];const m=Math.max(40,n*8);for(let k=0;k<m;k++){const t=6.2832*k/m;const rr=R+a*Math.abs(Math.cos(n*t/2+ph))-a*0.5;p.push([cx+rr*Math.cos(t),cy+rr*Math.sin(t)]);}return p;}
function arcT(s,cx,cy,r,a0,a1){const p=[];for(let k=0;k<=8;k++){const a=(a0+(a1-a0)*k/8)*Math.PI/180;p.push([cx+r*Math.cos(a),cy+r*Math.sin(a)]);}s.stroke(p,TEX,0.1,2.5);}
function irr(s,cx,cy,r,n,j=0.2){const u=(a,b)=>s.pen.u(a,b),p=[];for(let k=0;k<n;k++){const a=6.2832*k/n+u(-.2,.2);const rr=r*u(1-j,1+j*0.5);p.push([cx+rr*Math.cos(a),cy+rr*Math.sin(a)]);}return p;}
function shard(s,x,y,deg,L,Wd,fill){const P=rot([[x,y-L],[x+Wd/2,y-L+Wd*0.7],[x+Wd/2,y],[x-Wd/2,y],[x-Wd/2,y-L+Wd*0.7]],x,y,deg);s.shape(P,{fill,sw:DET,amp:0.05,step:1.8});const m=rot([[x,y-L+1.5],[x+Wd*0.08,y-1]],x,y,deg);s.line(m[0],m[1],DET,0.03);}
function frond(s,b,deg,len,w){const pts=[],oth=[];for(let k=0;k<=16;k++){const t=k/16,ww=w*Math.sin(Math.PI*Math.min(1,t*1.1))*(0.75+0.25*Math.abs(Math.sin(t*Math.PI*6)));const bend=6*t*t;pts.push([bend+ww,-len*t]);oth.unshift([bend-ww,-len*t]);}
 const R=p=>rot(p.map(([x,y])=>[b[0]+x,b[1]+y]),b[0],b[1],deg);s.shape(R([...pts,...oth]),{sw:DET,amp:0.05,step:1.8});const mid=[];for(let k=1;k<=14;k++){const t=k/16;mid.push([6*t*t,-len*t]);}s.stroke(R(mid),TEX,0.03,3);}
function blade(s,b,deg,len,w,fill=PAPER){const R=p=>rot(p.map(([x,y])=>[b[0]+x,b[1]+y]),b[0],b[1],deg),p=[];for(let k=0;k<=10;k++){const t=k/10;p.push([w*Math.sin(Math.PI*t)*(1-0.4*t),-len*t]);}for(let k=10;k>=0;k--){const t=k/10;p.push([-w*Math.sin(Math.PI*t)*(1-0.4*t)*0.6,-len*t]);}s.shape(R(p),{fill,sw:DET,amp:0.04,step:1.6});}
const N={};
N['tree']=()=>{const s=new Sheet(2,2,111),u=(a,b)=>s.pen.u(a,b);
 s.shape(lobed(100,100,80,11,12,0.3),{fill:SHADE,amp:0.6,step:4});
 s.shape(lobed(97,96,58,9,11,1.1),{sw:DET,amp:0.4,step:3});
 for(const[x,y,a]of[[70,74,200],[110,62,250],[134,98,320],[118,128,20],[80,122,120],[96,96,280],[62,104,160]])arcT(s,x,y,9,a,a+110);
 for(const[x,y,a]of[[38,64,190],[150,50,280],[164,132,350],[70,168,90],[132,168,60],[30,130,150]])arcT(s,x,y,8,a,a+100);
 return s;};
N['tree-dead']=()=>{const s=new Sheet(2,2,112),u=(a,b)=>s.pen.u(a,b),C=[100,100];
 const limb=(p0,deg,len,h,sw)=>{const pts=[];const tw=u(-18,18);for(let k=0;k<=6;k++){const t=k/6,a=(deg+tw*Math.sin(Math.PI*t))*Math.PI/180;const q=pts.length?pts[pts.length-1]:p0;pts.push(k===0?p0:[q[0]+Math.cos(a)*len/6,q[1]+Math.sin(a)*len/6]);}s.shape(band(pts,h),{sw,amp:0.1,step:2});return pts;};
 const mains=[8,82,148,214,292].map(a=>a+u(-8,8)),ends=[];
 for(const a of mains){const L=u(58,70);const r=a*Math.PI/180,f=[C[0]+Math.cos(r)*L*0.55,C[1]+Math.sin(r)*L*0.55];
  for(const d of[-34,30])limb(f,a+d+u(-6,6),u(20,28),2.2,DET);}
 for(const a of mains)limb(C,a,u(50,58),4.2,OUT);
 s.shape(irr(s,100,100,16,9,0.15),{amp:0.2,step:2.5});s.line([92,96],[104,106],TEX,0.05,0.8);
 return s;};
N['bush']=()=>{const s=new Sheet(1,1,113);
 s.shape(lobed(50,50,38,9,7,0.4),{fill:SHADE,amp:0.35,step:3});s.shape(lobed(48,48,27,7,6,1.3),{sw:DET,amp:0.25,step:2.5});
 for(const[x,y,a]of[[40,42,200],[56,40,270],[54,58,20],[40,58,120]])arcT(s,x,y,6,a,a+110);return s;};
N['stump']=()=>{const s=new Sheet(1,1,114),u=(a,b)=>s.pen.u(a,b);
 for(const a of[20,110,200,290])s.shape(rot(band(seg2([50,50],[50+38,50],4),5),50,50,a+u(-10,10)),{fill:SHADE,amp:0.15,step:2.5});
 s.shape(irr(s,50,50,34,11,0.08),{fill:SHADE,amp:0.3,step:3});
 const[f,out]=s.fo(irr(s,50,50,27.5,10,0.06),{amp:0.2,step:2.5,sw:DET});
 arcT(s,51,49,18,210,420);arcT(s,52,48,9.5,-40,170);s.line([60,64],[71,72],TEX,0.05,0.4);out();return s;};
N['log']=()=>{const s=new Sheet(2,1,115);
 s.shape(band(seg2([86,34],[98,20],3),4.2),{amp:0.1,step:2});s.shape(band(seg2([140,66],[150,80],3),4),{amp:0.1,step:2});
 const[l,out]=s.fo(band([[26,54],[70,50],[120,48],[172,46]],19,8),{amp:0.4,step:3});
 s.line([36,46],[90,43],TEX,0.15,0.8);s.line([104,56],[160,53],TEX,0.15,-0.8);s.line([60,60],[92,58],TEX,0.1,0.4);s.line([132,40],[162,39],TEX,0.1,0.4);
 out();return s;};
N['boulder']=()=>{const s=new Sheet(1,1,116);
 const[b,out]=s.fo(irr(s,50,52,36,9,0.14),{amp:0.3,step:3});
 s.stroke([[26,40],[44,46],[52,62],[50,78]],DET,0.2,4);s.line([60,30],[70,42],TEX,0.1,0.5);s.line([62,64],[74,70],TEX,0.1,-0.4);
 out();stone(s,86,82,5,{n:5,sw:DET});return s;};
N['boulder-large']=()=>{const s=new Sheet(2,2,117);
 const[b,out]=s.fo(irr(s,100,100,78,12,0.12),{amp:0.6,step:4});
 s.stroke([[34,70],[70,82],[98,112],[104,160]],DET,0.3,5);s.stroke([[98,112],[140,96],[170,74]],DET,0.3,5);s.stroke([[70,82],[82,40]],DET,0.3,5);
 s.stroke([[118,40],[124,56],[116,66]],TEX,0.1,3);s.stroke([[134,126],[150,140],[146,154]],TEX,0.1,3);s.stroke([[56,112],[66,130]],TEX,0.1,3);
 out();for(const[x,y,r]of[[176,170,7],[22,164,5],[186,40,5]])stone(s,x,y,r,{n:5,sw:DET});return s;};
N['stalagmites']=()=>{const s=new Sheet(1,1,118);
 for(const[x,y,r,dx,dy]of[[40,42,19,-2,-3],[66,58,15,2,-2],[36,74,11,-1,2],[70,28,8,1,-1]]){s.shape(irr(s,x,y,r,9,0.12),{fill:SHADE,amp:0.2,step:2.5});s.shape(irr(s,x+dx*2,y+dy*2,r*0.68,8,0.12),{sw:DET,amp:0.1,step:2});}
 return s;};
N['mushrooms']=()=>{const s=new Sheet(1,1,119);
 for(const[x,y,r,f]of[[34,40,9,SHADE],[46,34,13,PAPER],[40,52,10,PAPER],[64,62,8,SHADE],[72,52,11,PAPER],[62,74,9.5,PAPER],[28,70,7,PAPER]])s.shape(lobed(x,y,r,5,r*0.18,x),{fill:f,sw:DET,amp:0.06,step:1.8});
 return s;};
N['mushroom-giant']=()=>{const s=new Sheet(2,2,120);
 for(const[x,y,r]of[[30,160,8],[168,154,6],[160,40,5]])s.shape(ell(x,y,r,r*0.85),{sw:DET,amp:0.05,step:1.6});
 const[c,out]=s.fo(lobed(100,98,72,14,5,0.2),{amp:0.5,step:4});
 s.shape(irr(s,100,98,62,16,0.03),{fill:NONE,sw:TEX,amp:0.2,step:4});
 for(const[x,y,r]of[[80,70,11],[122,62,8],[132,100,12],[98,104,9],[70,118,8],[112,136,10],[60,88,6],[150,128,6]])s.shape(irr(s,x,y,r,8,0.15),{fill:SHADE,sw:DET,amp:0.1,step:2});
 out();return s;};
N['crystals']=()=>{const s=new Sheet(1,1,121);
 s.shape(irr(s,50,66,16,8,0.15),{fill:SHADE,amp:0.2,step:2.5});
 shard(s,44,64,-30,34,11,PAPER);shard(s,60,66,24,30,10,SHADE);shard(s,50,70,-4,44,13,PAPER);shard(s,38,72,-78,22,9,SHADE);shard(s,64,72,70,20,8,PAPER);
 stone(s,78,82,4,{n:5,sw:DET});return s;};
N['ferns']=()=>{const s=new Sheet(1,1,122),c=[50,54];
 for(const[a,l]of[[-10,40],[58,36],[128,38],[196,34],[258,36],[-70,30]])frond(s,c,a,l,7);
 s.shape(irr(s,50,54,6,7,0.1),{fill:SHADE,sw:DET,amp:0.05,step:1.5});return s;};
N['reeds']=()=>{const s=new Sheet(1,1,123);
 for(const[b,a,l]of[[[36,64],-20,40],[[38,66],30,34],[[62,56],-40,38],[[64,58],15,36],[[50,72],80,26],[[34,62],-80,28],[[66,60],100,24],[[48,70],-120,22]])blade(s,b,a,l,4);
 for(const[x,y,a]of[[30,28,-10],[56,20,6],[74,30,18],[44,40,-4]]){s.shape(rot(rrect(x-3.2,y-9,6.4,18,3.2),x,y,a),{fill:SHADE,sw:DET,amp:0.04,step:1.5});}
 return s;};
N['tent']=()=>{const s=new Sheet(2,2,124);
 for(const[p,q]of[[[34,22],[16,10]],[[166,22],[184,10]],[[34,164],[16,182]],[[166,164],[184,182]]]){s.line(p,q,DET,0.1);s.dot(q[0],q[1],2);}
 s.shape([[90,166],[70,168],[84,186]],{sw:DET,amp:0.1,step:2});s.shape([[110,166],[130,168],[116,186]],{sw:DET,amp:0.1,step:2});
 s.shape([[90,166],[110,166],[104,180],[96,180]],{fill:INK,sw:DET,amp:0.05,step:1.5});
 const[r,out]=s.fo(rrect(30,18,140,150,3),{amp:0.4,step:4});
 s.line([100,18.5],[100.5,167.5],DET,0.2);
 s.line([56,40],[70,62],TEX,0.15,0.6);s.line([140,96],[152,120],TEX,0.15,-0.6);s.line([60,124],[72,144],TEX,0.15,0.5);
 out();return s;};
N['fountain']=()=>{const s=new Sheet(2,2,125),u=(a,b)=>s.pen.u(a,b);
 const[rim,out]=s.fo(circ(100,100,86),{amp:0.6});
 for(let k=0;k<10;k++){const a=6.2832*(k+u(-.2,.2))/10+0.2;s.line([100+74*Math.cos(a),100+74*Math.sin(a)],[100+86*Math.cos(a),100+86*Math.sin(a)],DET,0.15);}
 out();
 s.shape(circ(100,100,74),{fill:SHADE,sw:DET,amp:0.4});
 arcT(s,100,100,44,200,250);arcT(s,100,100,56,10,60);arcT(s,100,100,34,100,150);
 s.shape(circ(100,100,20),{amp:0.2,step:2.5});s.shape(circ(100,100,13),{fill:SHADE,sw:DET,amp:0.1,step:2});
 s.shape([[100,93],[106,100],[100,107],[94,100]],{sw:DET,amp:0.03,step:1.3});return s;};
N['rowboat']=()=>{const s=new Sheet(1,3,126);
 const hw=y=>y<150?30*Math.sin(Math.PI/2*Math.min(1,(y-12)/130))**0.8:30-8*((y-150)/132)**2;
 const L=[],R=[];for(let y=12;y<=282;y+=6){L.push([50-hw(y),y]);R.unshift([50+hw(y),y]);}
 const[h,out]=s.fo([...R,...L],{amp:0.4,step:4});
 const iw=y=>Math.max(0,hw(y)-6),IL=[],IR=[];for(let y=30;y<=276;y+=6){IL.push([50-iw(y),y]);IR.unshift([50+iw(y),y]);}
 s.shape([...IR,...IL],{fill:SHADE,sw:DET,amp:0.25,step:3});
 for(const x of[40,60])s.line([x,70],[x+0.3,268],TEX,0.1);
 for(const y of[96,168,236])s.shape(band(seg2([50-hw(y)+3,y],[50+hw(y)-3,y],6),5),{sw:DET,amp:0.1,step:2});
 for(const sx of[-1,1]){const x=50+sx*13;s.shape(band(seg2([x,74],[x+sx*1.5,196],10),2.4),{sw:DET,amp:0.05,step:1.8});s.shape(rot(ell(x+sx*2,214,5,19),x+sx*2,214,sx*-1),{sw:DET,amp:0.05,step:1.6});}
 for(const y of[132,204])for(const sx of[-1,1])s.dot(50+sx*(hw(y)-1),y,1.6);
 out();return s;};
N['plank-bridge']=()=>{const s=new Sheet(1,3,127),u=(a,b)=>s.pen.u(a,b);
 for(const x of[16,84])for(const y of[16,284])s.shape(rrect(x-7,y-7,14,14,3),{fill:SHADE,amp:0.2,step:2.5});
 for(let y=27;y<=266;y+=17.1){const cy=y+u(-.6,.6),d=u(-2.5,2.5);s.shape(rot(rrect(22,cy,56,12,2),50,cy+6,d),{amp:0.2,step:3});if(u(0,1)<0.35)s.line([30,cy+6],[46,cy+6+u(-.5,.5)],TEX,0.1,0.4);}
 for(const x of[16,84])s.line([x,22],[x+(x<50?2:-2)*0,278],DET,0.3,x<50?-2:2);
 return s;};
N['drain-grate']=()=>{const s=new Sheet(1,1,128);
 const[f,out]=s.fo(rrect(18,18,64,64,3),{fill:SHADE,amp:0.3,step:3});
 s.shape(rrect(26,26,48,48,2),{fill:INK,sw:DET,amp:0.15,step:3});
 for(const x of[34.5,45.5,55,65.5])s.shape(band(seg2([x,24],[x,76],6),2.6),{fill:SHADE,sw:DET,amp:0.05,step:1.8});
 for(const[x,y]of[[22,22],[78,22],[78,78],[22,78]])s.dot(x,y,1.4);
 out();return s;};
N['stepping-stones']=()=>{const s=new Sheet(1,2,129);
 for(const[x,y,r,c]of[[42,30,22,true],[62,82,20,false],[40,130,21,true],[60,174,17,false]]){const[p,out]=s.fo(irr(s,x,y,r,9,0.14),{amp:0.3,step:3});if(c)s.line([x+r*0.2,y-r*0.6],[x+r*0.55,y-r*0.1],TEX,0.05,0.5);out();}
 return s;};

const NMETA=[
 ['nature','tree','Leafy Tree',2,2,['tree','canopy','leaves','forest','outdoor','wood'],'sight'],
 ['nature','tree-dead','Dead Tree',2,2,['tree','dead','bare','branches','swamp','forest'],'movement'],
 ['nature','bush','Bush',1,1,['bush','shrub','leaves','garden','forest','outdoor'],'movement'],
 ['nature','stump','Tree Stump',1,1,['stump','tree','rings','wood','forest','outdoor'],'movement'],
 ['nature','log','Fallen Log',2,1,['log','fallen','tree','wood','forest','outdoor'],'movement'],
 ['nature','boulder','Boulder',1,1,['boulder','rock','stone','cave','outdoor','mountain'],'movement'],
 ['nature','boulder-large','Large Boulder',2,2,['boulder','large','rock','cracks','cave','mountain'],'sight'],
 ['nature','stalagmites','Stalagmites',1,1,['stalagmites','cave','rock','underground','stone','cavern'],'movement'],
 ['nature','mushrooms','Mushroom Patch',1,1,['mushrooms','fungi','patch','cave','forest','swamp'],'none'],
 ['nature','mushroom-giant','Giant Mushroom',2,2,['mushroom','giant','fungi','cap','underdark','cave'],'sight'],
 ['nature','crystals','Crystal Cluster',1,1,['crystals','shards','gems','cave','magic','underdark'],'movement'],
 ['nature','ferns','Ferns',1,1,['ferns','fronds','plants','forest','jungle','outdoor'],'none'],
 ['nature','reeds','Reeds and Cattails',1,1,['reeds','cattails','marsh','swamp','water','plants'],'none'],
 ['nature','tent','Canvas Tent',2,2,['tent','canvas','camp','shelter','travel','outdoor'],'sight'],
 ['water','fountain','Stone Fountain',2,2,['fountain','water','stone','plaza','courtyard','garden'],'movement'],
 ['water','rowboat','Rowboat',1,3,['rowboat','boat','oars','water','river','dock'],'movement'],
 ['water','plank-bridge','Rope Plank Bridge',1,3,['bridge','planks','rope','chasm','river','crossing'],'none'],
 ['water','drain-grate','Drain Grate',1,1,['grate','drain','iron','sewer','floor','dungeon'],'none'],
 ['water','stepping-stones','Stepping Stones',1,2,['stepping','stones','river','crossing','garden','water'],'none']];
const nin={},nrep={};
for(const[cat,id,,w,h]of NMETA){const s=N[id]();if(s.W!==w*100||s.H!==h*100)throw id+' size';const svg=s.svg();nrep[id]=s.bad.length?s.bad.slice(0,3):0;
 const cols=[...new Set(svg.match(/#[0-9A-Fa-f]{6}/g))].filter(c=>![INK,PAPER,SHADE].includes(c));if(cols.length)nrep[id]={cols};
 await saveFile(`${cat}/${id}.svg`,svg);nin[id]=s.els;}
for(const cat of['nature','water']){const list=NMETA.filter(m=>m[0]===cat);let x=100;const H=Math.max(...list.map(m=>m[4]));const CH=(H+2)*100,base=(H+1)*100;const Wd=100+list.reduce((a,m)=>a+(m[3]+1)*100,0);
 let grid='';for(let gx=100;gx<Wd;gx+=100)grid+=`M${gx} 0V${CH}`;for(let gy=100;gy<CH;gy+=100)grid+=`M0 ${gy}H${Wd}`;
 let card=`<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}" height="${CH}" viewBox="0 0 ${Wd} ${CH}">\n  <rect width="${Wd}" height="${CH}" fill="#F0ECE0"/>\n  <path d="${grid}" fill="none" stroke="#DDD6C3" stroke-width="1.5"/>\n`;
 for(const[,id,,w,h]of list){card+=`  <svg x="${x}" y="${base-h*100}" width="${w*100}" height="${h*100}" viewBox="0 0 ${w*100} ${h*100}">\n`+nin[id].map(e=>'  '+e).join('\n')+`\n  </svg>\n  <text x="${x+w*50}" y="${base+36}" text-anchor="middle" font-family="ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="20" fill="#4A4336">${id}</text>\n`;x+=(w+1)*100;}
 await saveFile(`overview/${cat}.svg`,card+'</svg>\n');}
const nman=JSON.parse(await readFile('manifest.json')).filter(e=>e.category!=='nature'&&e.category!=='water');
const nall=[...nman,...NMETA.map(([category,id,name,w,h,tags,blocks])=>({id,name,category,w,h,tags,blocks}))];
const nids=nall.map(e=>e.id);if(new Set(nids).size!==nids.length)throw 'duplicate id '+nids.filter((x,i)=>nids.indexOf(x)!==i);
await saveFile('manifest.json','[\n'+nall.map(e=>'  '+JSON.stringify(e).replace(/,"/g,', "').replace(/":/g,'": ')).join(',\n')+'\n]\n');
log(JSON.stringify(nrep));
