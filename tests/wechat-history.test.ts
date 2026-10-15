import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runLocalHistory } from "../scripts/wechat/history.ts";
import type { WechatIntake } from "@aihot/contracts/wechat";

test("history persists only uploaded pages and resumes without repeating completed pages", async () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-history-synthetic-"));
  const script = join(root, "stream.py"), statePath = join(root, "state.json");
  writeFileSync(script, `import sys,json,pathlib
p=pathlib.Path(sys.argv[sys.argv.index('--resume')+1])
saved=json.loads(p.read_text()) if p.exists() else {}
scope='1@chatroom/message_1.db:1'
cursor=saved.get('positions',{}).get(scope,{}).get('local',0)
for i in (1,2):
 if i<=cursor:continue
 event={'group_id':'1@chatroom','group_name':'Synthetic','message_id':str(i),'sender_id':'member','sender_name':'Synthetic','content':'Synthetic history','sent_at':i,'revoked':False}
 print(json.dumps({'identity':'synthetic:1','groups':[{'id':'1@chatroom','name':'Synthetic'}],'pending':0,'rows':[{'local':scope+'/'+str(i),'target':'','event':event}],'position':{'scope':scope,'time':i,'local':i,'done':i==2}}),flush=True)
print(json.dumps({'complete':True,'identity':'synthetic:1'}),flush=True)
`);
  const options = { args: [script], account: "synthetic", groups: ["1@chatroom"], destination: "http://localhost",
    statePath, signal: new AbortController().signal };
  await assert.rejects(runLocalHistory({ ...options, send: async body => {
    if (body.events?.some(e => e.message_id === "2")) throw new Error("synthetic upload failure");
  } }), /upload failure/);
  const partial = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(partial.positions["1@chatroom/message_1.db:1"].local, 1);
  assert.equal(partial.uploaded, 1);
  assert.equal(partial.complete, false);
  const sent: WechatIntake[] = [];
  await runLocalHistory({ ...options, send: async body => { sent.push(body); } });
  assert.deepEqual(sent.flatMap(b => b.events ?? []).map(e => e.message_id), ["2"]);
  assert.equal(sent.at(-1)?.checkpoints?.[0]?.groupId, "1@chatroom");
  const complete = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(complete.complete, true);
  assert.equal(complete.uploaded, 2);
});
