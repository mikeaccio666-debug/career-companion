import { careerRecordId,careerRecordObject,parseMentorIntent,parseMentorRating,parseMentorRatingCommand,type MentorRatingCommand } from '@companion/platform-contracts';
import { captureMentorClient,type MentorIntentClient } from './mentor-intent-api.ts';
const fail=():never=>{throw Error('会后反馈暂时无法确认，请重新读取。');};
function pair(c:MentorIntentClient,id:string,input:unknown,operationId?:string){
 const v=careerRecordObject(input,['session','rating'],operationId?['operation']:[]),session=parseMentorIntent(v.session);
 if(!c.isCurrent()||session.id!==id||session.ownerId!==c.account.accountId||session.status!=='completed')return fail();
 const rating=v.rating===null?null:parseMentorRating(v.rating);
 if(rating&&(rating.sessionId!==session.id||rating.ownerId!==session.ownerId||rating.createdAt<session.updatedAt))return fail();
 let operation:Readonly<{id:string;replayed:boolean}>|undefined;
 if(operationId){const p=careerRecordObject(v.operation,['id','replayed']);if(p.id!==operationId||typeof p.replayed!=='boolean'||!rating||rating.operationId!==operationId)return fail();operation=Object.freeze({id:careerRecordId(p.id),replayed:p.replayed});}
 return Object.freeze({session,rating,...(operation?{operation}:{})});
}
export async function readMentorRating(c:MentorIntentClient,sessionId:string,signal?:AbortSignal){
 c=captureMentorClient(c);const id=careerRecordId(sessionId);return pair(c,id,await c.request('/career/mentor-intents/'+id+'/rating',{signal}));
}
export async function changeMentorRating(c:MentorIntentClient,sessionId:string,input:MentorRatingCommand,observe=false,signal?:AbortSignal){
 c=captureMentorClient(c);const id=careerRecordId(sessionId),command=parseMentorRatingCommand(input),path='/career/mentor-intents/'+id+'/rating';
 const value=await c.request(observe?path+'/operations/'+command.operationId:path,observe?{signal}:{method:'POST',body:JSON.stringify(command),signal});
 const result=pair(c,id,value,command.operationId),rating=result.rating!;
 if(rating.action!==command.action||command.action==='rate'&&(rating.score!==command.score||rating.comment!==command.comment)||observe&&!result.operation?.replayed)return fail();
 return result;
}
