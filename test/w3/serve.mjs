// Reopen the retained W3 acceptance workspace using the same local D1 as the live test.
import { startDesk } from './desk.mjs';

for (const name of ['W3_D1_PERSIST', 'W3_DESK_OWNER', 'W3_DESK_CLIENT', 'W3_DESK_SECRET']) {
    if (!process.env[name]) throw new Error('Missing ' + name);
}
const { mf } = await startDesk();
console.log('W3 Airedale: ' + (await mf.ready).origin + '/p/w3-demo');
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { void mf.dispose(); });
}
