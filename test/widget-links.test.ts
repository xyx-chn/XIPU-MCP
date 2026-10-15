import test from 'node:test';
import assert from 'node:assert/strict';
import { isDefaultDeadlineQuery, parseDeadlineLink } from '../src/widget-links.js';

test('widget links navigate only to the DDL page and known cached IDs',()=>{
  const known = (id:string)=>id==='deadline-1';
  assert.deepEqual(parseDeadlineLink('xipu-mcp://deadlines',known),{});
  assert.deepEqual(parseDeadlineLink('xipu-mcp://deadlines/?id=deadline-1',known),{deadlineId:'deadline-1'});
  for(const url of ['https://deadlines','xipu-mcp://settings','xipu-mcp://deadlines/elsewhere','xipu-mcp://u:p@deadlines','xipu-mcp://deadlines:8080','xipu-mcp://deadlines#other','xipu-mcp://deadlines?id=unknown','xipu-mcp://deadlines?id=deadline-1&id=deadline-1','xipu-mcp://deadlines?url=https://evil.example'])assert.equal(parseDeadlineLink(url,known),null,url);
});

test('course and date filters cannot replace the full widget cache',()=>{
  assert.equal(isDefaultDeadlineQuery({}),true);
  for(const args of [{courseIds:[]},{courseIds:['42']},{from:'2026-10-14T00:00:00Z'},{to:'2026-10-20T00:00:00Z'}])assert.equal(isDefaultDeadlineQuery(args),false);
});
