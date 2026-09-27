import {createEncryptedModuleStorage} from './encrypted-module-storage.js';

/** Derived inbox labels only; Runtime remains the task/Evidence store. */
export function createMailMetadataStorage({userData, safeStorage}) {
  return createEncryptedModuleStorage({userData,safeStorage,filename:'mail-classification.json'});
}
