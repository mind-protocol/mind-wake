import {expect,it} from "vitest";
import {projectWakesModel} from "./project-wakes.js";
it("reads the thread's own project, keeping absent intentions explicit",()=>{
  expect(projectWakesModel(null)).toBeNull();
  expect(projectWakesModel({projectId:"a",title:"A",inBlock:3,wakes:[{wake:3,objective:"Vérifier",expected:"Preuve"},{wake:4},{wake:99,objective:"Ignore"}]})).toEqual({projectId:"a",title:"A",inBlock:3,wakes:[{wake:3,objective:"Vérifier",expected:"Preuve"},{wake:4,objective:null,expected:null}]});
});
