import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlan, expectedResult, isSubmission, milestoneEvidence, semanticAction } from '../src/core/task-state.js';
import type { Observation } from '../src/core/types.js';
const view = ():Observation => ({id:'o',revision:'r',sessionId:'s',kind:'macos',targetId:'fixture',title:'Editor',text:'Form',capturedAt:0,truncated:false,elements:[
  {id:'r',role:'combobox',name:'Recipient',value:'Fictional Contact',focused:true,actions:['fill'],disabled:false},
  {id:'b',role:'textbox',name:'Body',value:'A small green frog.\n',multiline:true,actions:['fill'],disabled:false},
  {id:'c',role:'checkbox',name:'Include header',checked:true,actions:['click'],disabled:false},
],focusedId:'r'});
test('autocomplete selection Enter is not confused with sending from a multiline composer',()=>{
  const o=view(), enter={kind:'press',key:'Enter'} as const;
  assert.equal(isSubmission(enter,o),false);
  o.elements[0].focused=false;o.elements[1].focused=true;o.focusedId='b';
  assert.equal(isSubmission(enter,o),true);
  assert.equal(expectedResult({kind:'fill',elementId:'b',value:'A small green frog.\n',submit:true},o,o).status,'uncertain');
});
test('keyboard route signatures follow semantic focus and survive regenerated IDs',()=>{
  const a=view(), b=structuredClone(a), tab={kind:'press',key:'Tab'} as const;
  b.elements[0].id='fresh';b.focusedId='fresh';
  assert.equal(semanticAction(tab,a),semanticAction(tab,b));
  b.focusedId='b';
  assert.notEqual(semanticAction(tab,a),semanticAction(tab,b));
});
test('an unchanged unfinished milestone keeps its identity when revising a plan',()=>{
  const drafts=[{objective:'Write text',doneWhen:'Text is visible',uses:[]}];
  const p=createPlan(drafts);const revised=createPlan([...drafts,{objective:'Save',doneWhen:'Saved receipt',uses:[]}],p);
  assert.equal(revised.steps[0].id,p.steps[0].id);
  assert.notEqual(revised.steps[1].id,p.steps[0].id);
});
test('milestone evidence includes combined actual field values and checkbox state',()=>{
  const proof=milestoneEvidence(view(),{objective:'Fill form',doneWhen:'Contact and body present, header enabled',uses:[]});
  const combined=proof.find(e=>e.id==='current_snapshot')!.text;
  assert.match(combined,/Fictional Contact/);assert.match(combined,/A small green frog/);assert.match(combined,/checked=true/);
});
