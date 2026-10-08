export const id = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const at = '2026-10-08T12:00:00.000Z';
export const receipt = { kind:'birth_receipt', id:id(2), idempotencyKey:id(3), bornAt:at,
  identity:{companionId:id(4),name:'墨',nameOrigin:'user_typed',sealChar:'墨',inkToken:'dai',personaRevision:1,identityRevision:1,selectionRevision:1,sealAssetId:id(5)},
  main:{id:id(6),kind:'main',companionId:id(4)},event:{id:id(7),conversationId:id(6),companionId:id(4),kind:'event',event:'companion_born',speakerKind:'system',
    speakerSnapshot:{displayName:'系统',roleLabel:'系统',sealChar:null,inkToken:null,personaRevision:null},createdAt:at}};
export const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVuoAAAAASUVORK5CYII=','base64'));
