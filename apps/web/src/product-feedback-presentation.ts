import type {FeedbackCategory,FeedbackStatus,FeedbackTriage} from '@companion/platform-contracts';
export const feedbackCategories:Readonly<Record<FeedbackCategory,string>>={incorrect:'事实错了',out_of_character:'不像它',too_long:'太长',sales_pressure:'像推销',other:'其他'};
export const feedbackStatuses:Readonly<Record<FeedbackStatus,string>>={submitted:'已提交',in_review:'处理中',resolved:'已解决',closed:'已关闭'};
export const feedbackTriage:Readonly<Record<FeedbackTriage,string>>={defect:'功能问题',quality:'回答质量',policy:'规则与边界',content_gap:'内容缺口',request:'需求建议'};
/** Never retain or transmit the URL, query, hash, file name or record id. */
export function feedbackSurface(path:string){
 if(path.startsWith('/chats')||path==='/')return 'conversation' as const;
 if(path.startsWith('/today'))return 'today' as const;
 if(path.startsWith('/journey'))return 'journey' as const;
 if(path.startsWith('/pending'))return 'pending' as const;
 if(path.startsWith('/me'))return 'me' as const;
 if(path.startsWith('/welcome'))return 'onboarding' as const;
 return 'other' as const;
}
