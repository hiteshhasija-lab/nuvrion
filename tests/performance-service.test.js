import test from 'node:test';
import assert from 'node:assert/strict';
import {PerformanceService,normalizeMetricSample} from '../modules/monitoring/src/performance-service.js';

test('performance samples are normalized and scoped to their resource',async()=>{const service=new PerformanceService(),resources=[{id:'resource-1',nativeId:'vm-1'},{id:'resource-2',nativeId:'vm-2'}],observedAt=new Date().toISOString();const recorded=await service.record({id:'connection-1'},[{resourceType:'virtual_machine',nativeId:'vm-1',metrics:{observedAt,cpuUtilizationPercent:42.5,memoryUsedBytes:1073741824,source:'test'}},{resourceType:'virtual_machine',nativeId:'missing',metrics:{cpuUtilizationPercent:10}}],resources);assert.equal(recorded.length,1);assert.equal(service.history('resource-1').length,1);assert.equal(service.history('resource-2').length,0);assert.equal(service.latest('resource-1').cpuUtilizationPercent,42.5);});

test('invalid provider values do not become misleading measurements',()=>{const sample=normalizeMetricSample('resource-1',{cpuUtilizationPercent:120,memoryUtilizationPercent:-1,networkRxBytesPerSec:'not-a-number'});assert.equal(sample.cpuUtilizationPercent,null);assert.equal(sample.memoryUtilizationPercent,null);assert.equal(sample.networkRxBytesPerSec,null);});

test('retention removes expired performance samples',async()=>{const service=new PerformanceService({retentionMs:1000});await service.record({},[{nativeId:'vm-1',metrics:{observedAt:'2025-01-01T00:00:00.000Z',cpuUsageMhz:1}}],[{id:'resource-1',nativeId:'vm-1'}]);assert.equal(service.history('resource-1',{since:'2020-01-01T00:00:00.000Z'}).length,0);});
