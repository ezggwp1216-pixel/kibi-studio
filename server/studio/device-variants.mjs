import {createHash} from 'node:crypto';

export const DEVICE_VARIANTS=Object.freeze([
 Object.freeze({id:'basic',name:'Киби без динамика',speaker:false}),
 Object.freeze({id:'speaker',name:'Киби с динамиком',speaker:true}),
]);
export function assertDeviceVariant(value){
 if(!DEVICE_VARIANTS.some(item=>item.id===value))throw Object.assign(new Error('Выберите вариант Киби: с динамиком или без.'),{code:'invalid_device_variant',status:400});
 return value;
}
export function deviceVariantHeader(value){
 const variant=assertDeviceVariant(value);
 return Buffer.from('#pragma once\n// Managed by the trusted Kibi board selector; application code cannot edit this file.\n#define KIBI_DEVICE_HAS_SPEAKER '+(variant==='speaker'?'1':'0')+'\n');
}
export function identifyDeviceVariantHeader(bytes){
 if(!(bytes instanceof Uint8Array))return null;
 const hash=createHash('sha256').update(bytes).digest('hex');
 return DEVICE_VARIANTS.find(item=>createHash('sha256').update(deviceVariantHeader(item.id)).digest('hex')===hash)?.id??null;
}
