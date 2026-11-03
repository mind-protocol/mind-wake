import { tr } from "./i18n.js";
interface ProjectWakes {
  projectId:string; title:string; inBlock:number; total?:number; reason?:string;
  wakes:{wake:number;objective:string|null;expected:string|null}[];
}
export function projectWakesModel(value:unknown):ProjectWakes|null {
  if(!value || typeof value!=="object")return null;
  const row=value as Record<string,unknown>;
  if(typeof row["projectId"]!=="string" || typeof row["title"]!=="string" || !Array.isArray(row["wakes"]))return null;
  return {projectId:row["projectId"],title:row["title"],inBlock:typeof row["inBlock"]==="number"?row["inBlock"]:0,
    ...(typeof row["total"]==="number" ? {total:row["total"]}:{}),...(typeof row["reason"]==="string"?{reason:row["reason"]}:{}),
    wakes:row["wakes"].slice(0,10).flatMap(raw=>{if(!raw || typeof raw!=="object")return [];const s=raw as Record<string,unknown>;
      return typeof s["wake"]==="number" && Number.isInteger(s["wake"]) && s["wake"]>=1 && s["wake"]<=10 ? [{wake:s["wake"],objective:typeof s["objective"]==="string"?s["objective"]:null,expected:typeof s["expected"]==="string"?s["expected"]:null}]:[];})};
}
const expandedPlans=new Map<string,boolean>();
export function projectWakesCard(value:unknown,thread="main"):HTMLLIElement|null {
  const plan=projectWakesModel(value);if(!plan)return null;
  const card=document.createElement("li");card.className="project-wakes-card";
  const heading=document.createElement("strong");heading.textContent=tr("Objectifs des wakes · {0}", [plan.title]);
  const details=document.createElement("details"),summary=document.createElement("summary");
  summary.textContent=tr("Les {0} objectifs", [plan.wakes.length]);
  const stateKey=thread+':'+plan.projectId;
  details.open=expandedPlans.get(stateKey)??false;
  details.addEventListener("toggle",()=>expandedPlans.set(stateKey,details.open));
  const list=document.createElement("ol");
  for(const step of plan.wakes){
    const row=document.createElement("li");
    row.dataset["current"]=String(step.wake===plan.inBlock);
    row.dataset["defined"]=String(Boolean(step.objective));
    const label=document.createElement("p");label.textContent=`${step.wake===plan.inBlock?"▶ ":""}Wake ${step.wake}/${plan.total ?? 10} · ${step.objective || tr("Objectif à définir")}`;
    row.append(label);if(step.expected){const expected=document.createElement("small");expected.textContent=tr("Attendu : {0}", [step.expected]);row.append(expected);}
    if(step.wake===plan.inBlock){
      const current=document.createElement("div");
      current.append(...[...row.childNodes].map(node=>node.cloneNode(true)));
      current.dataset["defined"]=row.dataset["defined"]!;
      current.className="project-wakes-current";
      const label=current.querySelector("p");if(label)label.prepend(tr("En cours · "));
      card.append(current);
    }
    list.append(row);
  }
  const note=document.createElement("small");note.textContent=tr("Intentions révisables · l’étape courante est indiquée, sans présumer les précédentes terminées.");
  card.prepend(heading);
  if(plan.reason){const reason=document.createElement("p");reason.textContent=tr("Réassignation : {0}", [plan.reason]);card.append(reason);}
  details.append(summary,list,note);card.append(details);return card;
}
