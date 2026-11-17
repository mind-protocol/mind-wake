/** Keep unchanged message nodes attached, preserving text selection and loaded images. */
export function reconcileConversationChildren(container:HTMLElement,desired:HTMLElement[]):void{
 const keep=new Set<Element>(desired);for(const node of [...container.children])if(!keep.has(node))node.remove();let cursor=container.firstElementChild;for(const node of desired){if(node===cursor)cursor=cursor.nextElementSibling;else container.insertBefore(node,cursor);}
}
interface Anchor {node:HTMLElement;key:string|undefined;offset:number}
export interface ConversationPosition {follow:boolean;top:number;anchor?:Anchor}
/** NLR (17 Nov 2026): within 150 px of the bottom, the thread stays pinned to new and growing messages. */
export const FOLLOW_SLACK_PX=150;
export function conversationViewport(pane:HTMLElement,options:{observe?:boolean;schedule?:(callback:()=>void)=>void}={}){
 const distance=()=>pane.scrollHeight-pane.scrollTop-pane.clientHeight;
 const nearBottom=()=>distance()<FOLLOW_SLACK_PX;
 // Root cause of the manual scrolling: "near bottom" used to be measured at render time, after late images/ASCII had already
 // grown the content, so a reader who was at the bottom looked "scrolled up". The pinned state is now tracked on scroll only:
 // a downward or unchanged position never unpins; only a real move up beyond the slack does.
 let following=pane.clientHeight>0?nearBottom():true,lastTop=pane.scrollTop,smoothing=false,smoothTimer:ReturnType<typeof setTimeout>|undefined;
 const stopSmoothing=()=>{smoothing=false;if(smoothTimer!==undefined)clearTimeout(smoothTimer);smoothTimer=undefined;};
 const reduceMotion=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
 function pin(smooth=false){
  if(smooth&&typeof pane.scrollTo==='function'&&!reduceMotion()){
   smoothing=true;if(smoothTimer!==undefined)clearTimeout(smoothTimer);smoothTimer=setTimeout(stopSmoothing,1200);
   pane.scrollTo({top:pane.scrollHeight,behavior:'smooth'});
  }else{pane.scrollTop=pane.scrollHeight;}
  lastTop=pane.scrollTop;
 }
 function capture(forceFollow=false):ConversationPosition{const top=pane.getBoundingClientRect().top;const node=[...pane.children].find(n=>n.getBoundingClientRect().bottom>top+1) as HTMLElement|undefined;return{follow:forceFollow||following,top:pane.scrollTop,...(node?{anchor:{node,key:node.dataset['viewportKey']??node.dataset['messageId'],offset:node.getBoundingClientRect().top-top}}:{})};}
 let remembered=capture(),pending=false;const schedule=options.schedule??(callback=>requestAnimationFrame(callback));
 /** smooth: animate to a NEW message; re-pins after late growth stay instant (or retarget a running animation). */
 function restore(position:ConversationPosition,restoreOptions:{smooth?:boolean}={}){if(pane.clientHeight<=0)return;following=position.follow;if(position.follow)pin(restoreOptions.smooth===true||smoothing);else{stopSmoothing();let node=position.anchor?.node;if(node&&!pane.contains(node))node=[...pane.children].find(n=>((n as HTMLElement).dataset['viewportKey']??(n as HTMLElement).dataset['messageId'])===position.anchor?.key) as HTMLElement|undefined;pane.scrollTop=node&&position.anchor?pane.scrollTop+node.getBoundingClientRect().top-pane.getBoundingClientRect().top-position.anchor.offset:position.top;lastTop=pane.scrollTop;}remembered=capture(position.follow);}
 const resized=()=>{if(pane.clientHeight>0&&following)pin(smoothing);if(pending)return;pending=true;schedule(()=>{pending=false;restore(following&&pane.clientHeight>0?{...remembered,follow:true}:remembered);});};
 const scrolled=()=>{
  if(pane.clientHeight<=0)return;const top=pane.scrollTop;
  if(smoothing){following=true;if(distance()<=1)stopSmoothing();}
  else if(top<lastTop-1)following=nearBottom();
  else if(nearBottom())following=true;
  lastTop=top;remembered=capture();
 };
 // A user gesture interrupts our own animation: its scroll events are then judged normally.
 const interrupted=()=>{if(smoothing)stopSmoothing();};
 pane.addEventListener('scroll',scrolled,{passive:true});pane.addEventListener('load',resized,true);
 for(const name of ['wheel','touchstart','pointerdown','keydown'])pane.addEventListener(name,interrupted,{passive:true});
 let observer:ResizeObserver|undefined;if(options.observe!==false&&typeof ResizeObserver!=='undefined'){observer=new ResizeObserver(resized);}
 function watch(){observer?.disconnect();observer?.observe(pane);for(const child of [...pane.children])observer?.observe(child);}
 watch();return{capture:(forceFollow=false)=>pane.clientHeight>0?capture(forceFollow):remembered,restore,watch,following:()=>following,dispose(){stopSmoothing();observer?.disconnect();pane.removeEventListener('scroll',scrolled);pane.removeEventListener('load',resized,true);for(const name of ['wheel','touchstart','pointerdown','keydown'])pane.removeEventListener(name,interrupted);}};
}
/** Messages shown by default in the main thread, and added by each "show previous" click (NLR, 6 Nov 2026). Display only: data is never trimmed. */
export const CHAT_PAGE_SIZE=20;
/** Technical activity and FYI copies never spend the budget of conversational words. */
export function conversationMessageCount<T extends {from:string}>(items:readonly T[]):number{return items.filter(item=>['human','agent','received','session','sent'].includes(item.from)).length;}
export function conversationWindow<T extends {from:string}>(items:readonly T[],count:number):T[]{
 const visible=items.filter(item=>item.from!=='activity'&&item.from!=='context');let left=Math.max(1,count),start=0;for(let i=visible.length-1;i>=0;i--){if(['human','agent','received','session','sent'].includes(visible[i]!.from)&&--left===0){start=i;break;}}return visible.slice(start);
}
