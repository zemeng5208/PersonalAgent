import {TaskRuntime} from '../../dist/index.js';
const runtime = new TaskRuntime(process.argv[2]);
const store = runtime.bindCoordinationStore('a');
const revision = store.read().revision;
process.once('message', input => {
  let result;
  try { store.append(revision, input); result = 'committed'; }
  catch (error) { result = error.code; }
  finally { runtime.close(); }
  process.send(result, () => process.disconnect());
});
process.send('ready');
