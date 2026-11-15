/** Keep unchanged message nodes attached, preserving text selection and loaded images. */
export function reconcileConversationChildren(container:HTMLElement,desired:HTMLElement[]):void{
 const keep=new Set<Element>(desired);for(const node of [...container.children])if(!keep.has(node))node.remove();let cursor=container.firstElementChild;for(const node of desired){if(node===cursor)cursor=cursor.nextElementSibling;else container.insertBefore(node,cursor);}
}
interface Anchor {node:HTMLElement;key:string|undefined;offset:number}
export interface ConversationPosition {follow:boolean;top:number;anchor?:Anchor}
export function conversationViewport(pane:HTMLElement,options:{observe?:boolean;schedule?:(callback:()=>void)=>void}={}){
 const nearBottom=()=>pane.scrollHeight-pane.scrollTop-pane.clientHeight<100;
 function capture(forceFollow=false):ConversationPosition{const top=pane.getBoundingClientRect().top;const node=[...pane.children].find(n=>n.getBoundingClientRect().bottom>top+1) as HTMLElement|undefined;return{follow:forceFollow||nearBottom(),top:pane.scrollTop,...(node?{anchor:{node,key:node.dataset['viewportKey']??node.dataset['messageId'],offset:node.getBoundingClientRect().top-top}}:{})};}
 let remembered=capture(),pending=false;const schedule=options.schedule??(callback=>requestAnimationFrame(callback));
 function restore(position:ConversationPosition){if(pane.clientHeight<=0)return;if(position.follow)pane.scrollTop=pane.scrollHeight;else{let node=position.anchor?.node;if(node&&!pane.contains(node))node=[...pane.children].find(n=>((n as HTMLElement).dataset['viewportKey']??(n as HTMLElement).dataset['messageId'])===position.anchor?.key) as HTMLElement|undefined;pane.scrollTop=node&&position.anchor?pane.scrollTop+node.getBoundingClientRect().top-pane.getBoundingClientRect().top-position.anchor.offset:position.top;}remembered=capture(position.follow);}
 const resized=()=>{if(pending)return;pending=true;schedule(()=>{pending=false;restore(remembered);});};
 const scrolled=()=>{if(pane.clientHeight>0)remembered=capture();};pane.addEventListener('scroll',scrolled,{passive:true});pane.addEventListener('load',resized,true);
 let observer:ResizeObserver|undefined;if(options.observe!==false&&typeof ResizeObserver!=='undefined'){observer=new ResizeObserver(resized);}
 function watch(){observer?.disconnect();observer?.observe(pane);for(const child of [...pane.children])observer?.observe(child);}
 watch();return{capture:(forceFollow=false)=>pane.clientHeight>0?capture(forceFollow):remembered,restore,watch,dispose(){observer?.disconnect();pane.removeEventListener('scroll',scrolled);pane.removeEventListener('load',resized,true);}};
}
/** Messages shown by default in the main thread, and added by each "show previous" click (NLR, 6 Nov 2026). Display only: data is never trimmed. */
export const CHAT_PAGE_SIZE=20;
/** Technical activity and FYI copies never spend the budget of conversational words. */
export function conversationMessageCount<T extends {from:string}>(items:readonly T[]):number{return items.filter(item=>['human','agent','received','session','sent'].includes(item.from)).length;}
export function conversationWindow<T extends {from:string}>(items:readonly T[],count:number):T[]{
 const visible=items.filter(item=>item.from!=='activity'&&item.from!=='context');let left=Math.max(1,count),start=0;for(let i=visible.length-1;i>=0;i--){if(['human','agent','received','session','sent'].includes(visible[i]!.from)&&--left===0){start=i;break;}}return visible.slice(start);
}
