// Tutorial controls only: page navigation and playback scheduling.
// All element animation belongs to the existing engine.js / Reveal auto-animate.
const frame = document.querySelector('#deck');
const play = document.querySelector('#play');
const next = document.querySelector('#next');
const speed = document.querySelector('#speed');
const status = document.querySelector('#status');
const states = [...document.querySelectorAll('[data-page]')];
const lessons = [
 ['先摆好四栏。','第一栏显示瓶子，其他三栏显示编号、名称和按钮。下一只瓶子先放在画面下方，等下一页移动进来。'],
 ['移动色块，交接两只瓶子。','第二页把同一个色块移到第二栏并变粉。橙瓶的终点在画面上方，粉瓶从画面下方移到展示位。前后两页都有这两只瓶子。'],
 ['沿用同一个规则。','把主角从第二栏换到第三栏。已有的名称、编号和按钮继续配对；不参与切换的栏保持位置，观众就能跟住正在变化的部分。'],
 ['先让第四栏成为主角。','青色面板移到第四栏，荔枝瓶出现。这一页也是全屏展开的起点：下一页要保留同一只瓶子和同一块青色面板。'],
 ['把这一栏展开成整页。','青色面板扩展为整页，荔枝瓶居中放大。前三栏文字淡出，大字放在瓶子后面，容量选项最后出现。不要换成另一张整页截图。'],
];
let reveal, timers=[], playing=false;
function stop(){timers.forEach(clearTimeout);timers=[];playing=false;play.textContent='从头播放';}
function refresh(){const i=reveal.getIndices().h;states.forEach((b,n)=>b.setAttribute('aria-pressed',String(n===i)));document.querySelector('#step-label').textContent=`状态 0${i+1}`;document.querySelector('#step-title').textContent=lessons[i][0];document.querySelector('#step-body').textContent=lessons[i][1];status.textContent=`${i+1} / 5${playing?' · 播放中':''}`;next.disabled=i===4;}
function timing(){const factor=Number(speed.value);const slides=reveal.getSlides();slides.forEach(slide=>{slide.querySelectorAll('[data-auto-animate-duration],[data-auto-animate-delay]').forEach(el=>{for(const key of ['autoAnimateDuration','autoAnimateDelay'])if(el.dataset[key]!==undefined){const baseKey=`base${key[0].toUpperCase()}${key.slice(1)}`;el.dataset[baseKey]??=el.dataset[key];el.dataset[key]=String(Number(el.dataset[baseKey])*factor);}});slide.dataset.baseDuration??=slide.dataset.autoAnimateDuration;slide.dataset.autoAnimateDuration=String(Number(slide.dataset.baseDuration)*factor);});}
function bind(){reveal=frame.contentWindow.Reveal;if(!reveal)return;const ready=()=>{timing();play.disabled=false;next.disabled=false;reveal.on('slidechanged',refresh);refresh();};if(reveal.isReady())ready();else reveal.on('ready',ready);}
play.disabled=true;next.disabled=true;
frame.addEventListener('load',bind);
if(frame.contentWindow.Reveal)bind();
play.addEventListener('click',()=>{stop();timing();reveal.slide(0);playing=true;play.textContent='重新播放';refresh();const factor=Number(speed.value);[900,2200,3533.333,4800].forEach((ms,i)=>timers.push(setTimeout(()=>reveal.slide(i+1),ms*factor)));timers.push(setTimeout(()=>{stop();refresh();},6033.334*factor));});
next.addEventListener('click',()=>{stop();reveal.next();refresh();});
states.forEach((button,i)=>button.addEventListener('click',()=>{stop();reveal.slide(i);refresh();}));
speed.addEventListener('change',()=>{stop();timing();refresh();status.textContent+=' · 下次转场使用新速度';});
document.querySelector('#copy').addEventListener('click',async()=>{const input=document.querySelector('#prompt');try{await navigator.clipboard.writeText(input.value);document.querySelector('#copy-status').textContent='已复制。把方括号内容替换为你的素材后交给 AI。';}catch{input.focus();input.select();document.querySelector('#copy-status').textContent='提示词已选中，请按 ⌘C / Ctrl+C 复制。';}});
window.addEventListener('pagehide',stop);
