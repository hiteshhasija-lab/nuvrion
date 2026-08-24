import { randomUUID } from 'node:crypto';
export class MockProvider {
  #operations = new Map();
  #inventory = [
    { resourceType:'virtual_machine', nativeId:'mock-vm-001', name:'nuvrion-app-01', healthState:'healthy', attributes:{ powerState:'running', guestOs:'Ubuntu 24.04', vcpuCount:4, memoryBytes:8589934592, storageBytes:107374182400, privateIps:['10.20.1.10'], region:'local', availabilityZone:'lab-a', providerShape:'mock.medium' }, providerMetadata:{ folder:'/Production', toolsStatus:'current' } },
    { resourceType:'virtual_machine', nativeId:'mock-vm-002', name:'nuvrion-db-01', healthState:'warning', attributes:{ powerState:'stopped', guestOs:'Windows Server 2025', vcpuCount:8, memoryBytes:17179869184, storageBytes:214748364800, privateIps:['10.20.1.20'], region:'local', availabilityZone:'lab-b', providerShape:'mock.large' }, providerMetadata:{ folder:'/Databases', toolsStatus:'outdated' } }
  ];
  async execute(operation, targetId) { const providerReference=`mock:${randomUUID()}`;this.#operations.set(providerReference,{operation,targetId});return { providerReference, operation, targetId }; }
  async verify(providerReference) { const accepted=this.#operations.get(providerReference);const observedFinalState=accepted?.operation==='stop'?'stopped':'running';return { code: 'NUV_OPERATION_VERIFIED', summary: 'Mock provider verified the requested final state.', providerReference, observedFinalState }; }
  async discover() { return structuredClone(this.#inventory); }
  setInventory(items) { this.#inventory = structuredClone(items); }
}
