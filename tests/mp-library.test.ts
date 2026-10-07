import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { mpLibrary, mpArticleDetail } from "@aihot/backend/publication/mp";
import { researchReferences, researchTerms } from "@aihot/backend/publication/research";
import { researchTurn } from "@aihot/backend/research";
import { runMpArchive, archiveState, archiveAction } from "@aihot/backend/sources/mp-archive";
import { fetchWechatPage } from "@aihot/backend/providers/wechat-page";
import { queueProcessing, resumeSourceArticles } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
config.wechatPageIntervalSeconds = 0;
const source = `mp-library-${tag()}`;
const account = `test-${source}`;
await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, config, next_fetch_at)
 VALUES (${source}, '测试公众号资料库', 'mp_account', 'T2', 'editorial', true, ${sql.json({ ghid: account })}, '2100-01-01')`;
let budgets: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
 budgets = await sql`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service IN ('dajiala', 'llm')`;
 await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service IN ('dajiala', 'llm')`;
});
after(async () => {
 for (const b of budgets) await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = ${b.service}`;
 await stopBoss();
 await closeDb();
});

test("unselected account materials remain readable, while isolation and fulltext permissions apply", async () => {
 const { articleId } = await upsertMaterial({ sourceId: source, url: `https://mp.weixin.qq.com/s/${source}`, title: '关键词建站策略',
  bodyHtml: '<p>关键词研究方法</p>', bodyText: '关键词研究方法', bodyStatus: 'ok', via: 'import', raw: { mpArchive: true } });
 assert.equal((await mpLibrary({ source })).items.some(a => a.id === articleId), true);
 assert.match((await mpArticleDetail(articleId))!.html!, /关键词研究/);
 assert.equal((await researchReferences(articleId, '关键词', 'article')).length, 1);
 assert.equal(await queueProcessing(articleId), null);
 await sql`UPDATE articles SET processing_state = 'skipped' WHERE id = ${articleId}`;
 await sql.begin(tx => resumeSourceArticles(source, tx));
 const [row] = await sql`SELECT processing_state FROM articles WHERE id = ${articleId}`;
 assert.equal(row.processing_state, 'skipped');
 await sql`UPDATE sources SET site_fulltext = false WHERE id = ${source}`;
 assert.equal((await mpArticleDetail(articleId))!.html, null);
 assert.equal((await researchReferences(articleId, '关键词', 'article'))[0]!.material, 'summary');
 await sql`UPDATE sources SET participation_mode = 'isolated' WHERE id = ${source}`;
 assert.equal(await mpArticleDetail(articleId), null);
 assert.deepEqual(await researchReferences(articleId, '关键词', 'all'), []);
 await sql`UPDATE sources SET participation_mode = 'editorial', site_fulltext = true WHERE id = ${source}`;
});

test("history pagination persists each bounded batch, resumes cursor, and stops at provider end", async () => {
 const offsets: string[] = [];
 const server = await stub((_hit, request) => {
  const input = JSON.parse(request.body); offsets.push(input.offset);
  return { code: 0, cost_money: 0.14, offset: input.offset ? '' : 'next-page', is_end: input.offset ? 1 : 0,
   data: [{ title: `归档-${input.offset || 'first'}`, url: `https://mp.weixin.qq.com/s/${source}-${input.offset || 'first'}`, post_time: 1700000000 }] };
 });
 process.env.DAJIALA_KEY = 'test-key'; process.env.DAJIALA_BASE_URL = server.url;
 config.allowPrivateNetworkFetch = true;
 const runId = randomUUID();
 await sql`INSERT INTO settings (key, value) VALUES (${`mp_archive:${source}`}, ${sql.json({ runId, mode: 'list', status: 'queued', offset: '', pages: 0, stored: 0, bodies: 0, failed: 0, listComplete: false, lastReceiptId: null, error: null })})`;
 try {
  await runMpArchive(source, runId, 1);
  let state = (await archiveState(source))!;
  assert.equal(state.status, 'paused', state.error ?? ''); assert.equal(state.pages, 1); assert.equal(state.offset, 'next-page');
  await sql`UPDATE settings SET value = value || '{"status":"queued"}'::jsonb WHERE key = ${`mp_archive:${source}`}`;
  await runMpArchive(source, runId, 1);
  state = (await archiveState(source))!;
  assert.equal(state.status, 'completed'); assert.equal(state.listComplete, true); assert.equal(state.stored, 2);
  assert.deepEqual(offsets, ['', 'next-page']);
  const rows = await sql`SELECT processing_state FROM articles WHERE source_id = ${source} AND raw->>'mpArchive' = 'true'`;
  assert.equal(rows.every(r => r.processing_state === 'skipped'), true);
 } finally { await server.close(); }
});

test("research records are private to their owner; Chinese retrieval removes filler words", async () => {
 const id = randomUUID();
 await sql`INSERT INTO settings (key, value) VALUES (${`research:${id}`}, ${sql.json({ id, owner: source })})`;
 assert.equal((await researchTurn(id, source))!.id, id);
 assert.equal(await researchTurn(id, 'someone-else'), null);
 assert.ok(researchTerms('请问如何进行关键词研究').includes('关键'));
 assert.equal(researchTerms('请问如何解释一下').includes('请问'), false);
});

test("research worker uses only retrieved references and stores cited answers without duplicate model calls", async () => {
 const { answerResearch } = await import('@aihot/backend/research');
 const id = randomUUID();
 const [article] = await sql`SELECT id FROM articles WHERE source_id = ${source} ORDER BY created_at LIMIT 1`;
 const server = await stub((_hit, req) => {
  const body = JSON.parse(req.body);
  const context = JSON.parse(body.messages[1].content);
  assert.equal(context.materials.length, 1);
  assert.equal(context.materials[0].number, 1);
  return { id: 'test-answer', choices: [{ message: { content: JSON.stringify({ answer: '依据文章，可先研究关键词。[1]', citations: [1, 5] }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
 });
 process.env.LLM_BASE_URL = server.url; process.env.LLM_API_KEY = 'test-key'; process.env.LLM_MODEL = 'test-model';
 config.modelCallsEnabled = true;
 await sql`INSERT INTO settings (key, value) VALUES (${`research:${id}`}, ${sql.json({ id, owner: source, articleId: article.id, question: `怎样实践？${source}`, scope: 'article', status: 'queued', previousId: null, references: [], citations: [], answer: null, error: null })})`;
 try {
  await answerResearch(id);
  const turn = (await researchTurn(id, source))!;
  assert.equal(turn.status, 'completed', turn.error ?? '');
  assert.deepEqual(turn.citations, [1]); assert.equal(turn.references.length, 1);
  await answerResearch(id); assert.equal(server.hits(), 1);
 } finally { await server.close(); }
});

test("an EveryInfra history list is one async listing, complete for that provider until the provider changes", async () => {
 const id = `${source}-ei`;
 await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, config, next_fetch_at)
  VALUES (${id}, '万有引擎归档', 'mp_account', 'T2', 'editorial', ${sql.json({ ghid: `gh-${id}`, listProvider: 'everyinfra' })}, '2100-01-01')`;
 const mock = new MockAgent(); mock.disableNetConnect();
 const api = mock.get('https://api.everyinfra.com');
 let submitted: { mode?: string } = {};
 api.intercept({ path: '/api/v1/social', method: 'POST' }).reply(({ body }) => {
  submitted = JSON.parse(String(body));
  return { statusCode: 202, data: { job_id: 'job_1', status: 'running', billing: { charged: true, amount: { base: 'USD', amount: 0.00555556 } } } };
 });
 api.intercept({ path: '/api/v1/jobs/job_1' }).reply(200, { job_id: 'job_1', status: 'succeeded', results: [1, 2].map(i => ({
  title: `旧文 ${i}`, url: `https://mp.weixin.qq.com/s/${id}-${i}`, posted_at: '2025-12-05T15:56:00+00:00' })) });
 const previous = getGlobalDispatcher(); setGlobalDispatcher(mock);
 process.env.EVERYINFRA_API_KEY = 'test-key';
 config.allowPrivateNetworkFetch = true;
 const saved = process.env.COLLECT_ENABLED; process.env.COLLECT_ENABLED = 'true';
 try {
  const queued = (await archiveAction(id, { action: 'list', maxRequests: 5 }, 'test'))!;
  assert.equal(queued.listProvider, 'everyinfra');
  await runMpArchive(id, queued.runId, 5);
  const state = (await archiveState(id))!;
  assert.equal(state.status, 'completed', state.error ?? '');
  assert.deepEqual([state.pages, state.stored, state.listComplete], [1, 2, true], 'one paid listing, no further pages');
  assert.equal(submitted.mode, 'async');
  const [receipt] = await sql`SELECT request_id, cost FROM receipts WHERE id = ${state.lastReceiptId}`;
  assert.deepEqual([receipt!.request_id, Number(receipt!.cost)], ['job_1', 0.005556], 'the job is the request and the submission carries the charge');
  await assert.rejects(archiveAction(id, { action: 'list' }, 'test'), /万有引擎只能获取最近一批文章/);
  await sql`UPDATE sources SET config = config || '{"listProvider":"dajiala"}'::jsonb WHERE id = ${id}`;
  process.env.DAJIALA_KEY = 'test-key';
  const restarted = (await archiveAction(id, { action: 'list', maxRequests: 1 }, 'test'))!;
  assert.deepEqual([restarted.listProvider, restarted.offset, restarted.listComplete], ['dajiala', '', false], 'another provider starts the list again');
  await sql`UPDATE settings SET value = value || '{"status":"paused"}'::jsonb WHERE key = ${`mp_archive:${id}`}`;
 } finally {
  setGlobalDispatcher(previous); await mock.close();
  if (saved === undefined) delete process.env.COLLECT_ENABLED; else process.env.COLLECT_ENABLED = saved;
 }
});

test("missing bodies are read free for daily articles too, without sending them back to analysis", async () => {
 const id = `${source}-bodies`;
 await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, config, next_fetch_at)
  VALUES (${id}, '补全文', 'mp_account', 'T2', 'editorial', ${sql.json({ ghid: `gh-${id}` })}, '2100-01-01')`;
 const daily = await upsertMaterial({ sourceId: id, url: `https://mp.weixin.qq.com/s/${id}-daily`, title: '日常文章', language: 'zh', excerpt: '摘要', bodyStatus: 'none', via: 'fetch', raw: { dajiala: {} } });
 await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${daily.articleId}`;
 const mock = new MockAgent(); mock.disableNetConnect();
 mock.get('https://mp.weixin.qq.com').intercept({ path: `/s/${id}-daily` })
  .reply(200, '<html><body><div id="js_content"><p>日常文章的正文</p></div></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
 const previous = getGlobalDispatcher(); setGlobalDispatcher(mock);
 config.allowPrivateNetworkFetch = true;
 const runId = randomUUID();
 await sql`INSERT INTO settings (key, value) VALUES (${`mp_archive:${id}`}, ${sql.json({ runId, mode: 'bodies', status: 'queued', offset: '', pages: 0, stored: 0, bodies: 0, failed: 0, listComplete: false, lastReceiptId: null, error: null })})`;
 try {
  await runMpArchive(id, runId, 5);
  const state = (await archiveState(id))!;
  assert.deepEqual([state.status, state.bodies], ['completed', 1], state.error ?? '');
  const [row] = await sql`SELECT body_status, body_text, processing_state, raw->>'mpArchive' AS archived FROM articles WHERE id = ${daily.articleId}`;
  assert.deepEqual([row!.body_status, row!.processing_state, row!.archived], ['ok', 'analyzed', null]);
  assert.match(row!.body_text, /日常文章的正文/);
 } finally { setGlobalDispatcher(previous); await mock.close(); }
});

test("WeChat pages are spaced across processes, and a verification page pauses them all", async () => {
 const saved = await sql`SELECT value FROM settings WHERE key = 'wechat_page_pace'`;
 const mock = new MockAgent(); mock.disableNetConnect();
 const wechat = mock.get('https://mp.weixin.qq.com');
 let hits = 0;
 wechat.intercept({ path: /^\/s\/pace-/ }).reply(() => { hits++; return { statusCode: 200, data: '<div id="js_content"><p>正文</p></div>' }; }).persist();
 wechat.intercept({ path: '/s/captcha' }).reply(() => { hits++; return { statusCode: 200, data: '<p>当前环境异常，完成验证后即可继续访问</p>' }; });
 const previous = getGlobalDispatcher(); setGlobalDispatcher(mock);
 config.allowPrivateNetworkFetch = true;
 try {
  await sql`DELETE FROM settings WHERE key = 'wechat_page_pace'`;
  config.wechatPageIntervalSeconds = 1;
  const started = Date.now();
  await Promise.all([fetchWechatPage('https://mp.weixin.qq.com/s/pace-1'), fetchWechatPage('https://mp.weixin.qq.com/s/pace-2')]);
  assert.ok(Date.now() - started >= 1000, 'the second request waits for its slot');
  await assert.rejects(fetchWechatPage('https://mp.weixin.qq.com/s/pace-3', { maxWaitMs: 0 }), /queue is full/, 'a slot too far away is not taken');
  config.wechatPageIntervalSeconds = 0;
  await sql`UPDATE settings SET value = value - 'nextAt' WHERE key = 'wechat_page_pace'`;
  await assert.rejects(fetchWechatPage('https://mp.weixin.qq.com/s/captcha'), /verification/);
  const before = hits;
  await assert.rejects(fetchWechatPage('https://mp.weixin.qq.com/s/pace-4'), /paused until/);
  assert.equal(hits, before, 'nothing is requested while paused');
  const pause = async () => (await sql<{ value: { cooldownMs: number } }[]>`SELECT value FROM settings WHERE key = 'wechat_page_pace'`)[0]!.value.cooldownMs;
  assert.equal(await pause(), 3600_000);
  // The pause ends and the block is still there: the next pause is twice as long.
  await sql`UPDATE settings SET value = value || ${sql.json({ coolUntil: new Date(Date.now() - 60_000).toISOString() })} WHERE key = 'wechat_page_pace'`;
  wechat.intercept({ path: '/s/captcha' }).reply(() => { hits++; return { statusCode: 200, data: '<p>当前环境异常，完成验证后即可继续访问</p>' }; });
  await assert.rejects(fetchWechatPage('https://mp.weixin.qq.com/s/captcha'), /verification/);
  assert.equal(await pause(), 7200_000);
 } finally {
  config.wechatPageIntervalSeconds = 0;
  setGlobalDispatcher(previous); await mock.close();
  await sql`DELETE FROM settings WHERE key = 'wechat_page_pace'`;
  if (saved[0]) await sql`INSERT INTO settings (key, value) VALUES ('wechat_page_pace', ${sql.json(saved[0].value)})`;
 }
});
