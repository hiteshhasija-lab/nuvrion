// A small simulated standalone ESXi host for testing the ESXi provider without a lab. It answers the SOAP calls the provider makes at /sdk (session, container
// views, property retrieval with paging, power tasks, guest shutdown and reboot, console tickets, CD/DVD reconfiguration) and the datastore file browser
// under /folder. Virtual machines keep real state that changes as tasks run, and the host can be told to fail. Pass `fake.fetch` as the provider's fetchImpl.
//
// Faults follow the way vSphere reports them: every SOAP fault, including a wrong password, comes back as HTTP 500 with a <faultstring> and a fault type.
import { datastoreFolderResponse } from './fake-datastore.js';

const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const unesc = value => String(value ?? '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');
const soap = (body, headers = {}, status = 200) => new Response(`<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`, { status, headers: { 'content-type': 'text/xml', ...headers } });
const fault = (message, type = 'RuntimeFault') => soap(`<soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>${esc(message)}</faultstring><detail><${type}Fault xsi:type="${type}"/></detail></soapenv:Fault>`, {}, 500);

// Devices are written the way vSphere writes them: the file or network sits inside <backing>, the connection flags inside <connectable>.
const flat = fields => Object.entries(fields).filter(([, v]) => v != null).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
const device = (type, key, fields, { backing = null, connectable = null } = {}) => `<VirtualDevice xsi:type="${type}"><key>${key}</key>${flat(fields)}${backing ? `<backing xsi:type="${backing.type}">${flat(backing.fields)}</backing>` : ''}${connectable ? `<connectable>${flat({ startConnected: connectable.startConnected, allowGuestControl: true, connected: connectable.connected })}</connectable>` : ''}</VirtualDevice>`;

export function sampleEsxiVm(id = 'vm-1', over = {}) {
  return {
    id, name: `Guest ${id}`, power: 'poweredOn', overall: 'green', ip: '10.0.0.60', hostName: `${id}.lab.example`, guestFullName: 'Ubuntu Linux (64-bit)', cpu: 2, memoryMB: 4096,
    tools: 'guestToolsRunning', toolsVersionStatus: 'guestToolsCurrent', toolsVersion: '12352', guestState: 'running', uptime: 7200,
    quickStats: { cpu: 800, hostMem: 1024, guestMem: 512, committed: 30 * 1024 ** 3, uncommitted: 10 * 1024 ** 3 },
    disks: [{ key: 2000, label: 'Hard disk 1', capacityInBytes: 40 * 1024 ** 3, fileName: `[datastore1] ${id}/${id}.vmdk` }],
    nics: [{ key: 4000, label: 'Network adapter 1', macAddress: '00:0c:29:11:22:33', deviceName: 'VM Network', connected: true, startConnected: true }],
    cdroms: [{ key: 3002, label: 'CD/DVD drive 1', media: null, connected: false, startConnected: false }],
    ...over
  };
}

export function fakeEsxi({ vms = [sampleEsxiVm()], username = 'root', password = 'correct-password', hostName = 'esxi01.lab.example', isos = { datastore1: ['images/', 'images/server.iso'] }, pageSize = 100 } = {}) { // secret-scan:allow (fake test credential)
  const state = {
    vms: new Map(vms.map(vm => [vm.id, structuredClone(vm)])), isos, tasks: new Map(), sessions: new Set(), hostName,
    taskPolls: 1,             // how many property reads a task stays "running" for
    shutdownPolls: 2, rebootPolls: 2, guestIgnoresRequests: false,
    sessionsOpened: 0, sessionsClosed: 0, taskSeq: 0, snapshotSeq: 0, configSeq: 0
  };
  const calls = [];
  const faults = { unreachable: false, emptyServiceContent: false, http: new Map() };   // faults.http: SOAP method name -> { status, message, type } (status 401/403/404/503 use a non-SOAP error)
  const guestPending = new Map();

  const objectXml = (type, id, props) => `<objects><obj type="${type}">${esc(id)}</obj>${Object.entries(props).filter(([, v]) => v != null).map(([name, val]) => `<propSet><name>${name}</name><val xsi:type="xsd:string">${val}</val></propSet>`).join('')}</objects>`;
  const vmProps = vm => ({
    name: esc(vm.name), 'runtime.powerState': vm.power, overallStatus: vm.overall, 'guest.ipAddress': vm.ip, 'guest.hostName': vm.hostName, 'guest.toolsRunningStatus': vm.tools,
    'guest.toolsVersionStatus2': vm.toolsVersionStatus, 'guest.toolsVersion': vm.toolsVersion, 'guest.guestState': vm.guestState, 'config.guestFullName': esc(vm.guestFullName),
    'config.hardware.numCPU': vm.cpu, 'config.hardware.memoryMB': vm.memoryMB,
    'config.hardware.device': hardwareXml(vm),
    'summary.quickStats.overallCpuUsage': vm.quickStats?.cpu, 'summary.quickStats.hostMemoryUsage': vm.quickStats?.hostMem, 'summary.quickStats.guestMemoryUsage': vm.quickStats?.guestMem,
    'summary.quickStats.uptimeSeconds': vm.uptime, 'summary.storage.committed': vm.quickStats?.committed, 'summary.storage.uncommitted': vm.quickStats?.uncommitted,
    ...configProps(vm),
    snapshot: snapshotXml(vm), 'capability.snapshotOperationsSupported': vm.snapshotsSupported === false ? 'false' : 'true', 'runtime.consolidationNeeded': String(Boolean(vm.consolidationNeeded))
  });
  // Settings the VM carries besides its devices; `vm.config` overrides any of them.
  const configOf = vm => ({ annotation: '', guestId: 'ubuntu64Guest', version: 'vmx-19', changeVersion: '2026-10-07T00:00:00.000Z', coresPerSocket: 1, cpuHotAdd: false, memoryHotAdd: false, memoryReservationLockedToMax: false, nestedHV: false, firmware: 'bios', standbyAction: 'powerOnSuspend', extraConfig: [{ key: 'svga.present', value: 'TRUE' }], ...vm.config });
  const configProps = vm => {
    const c = configOf(vm);
    return {
      environmentBrowser: 'envbrowser-1', 'config.annotation': esc(c.annotation), 'config.guestId': c.guestId, 'config.version': c.version, 'config.changeVersion': c.changeVersion,
      'config.hardware.numCoresPerSocket': c.coresPerSocket, 'config.cpuHotAddEnabled': String(c.cpuHotAdd), 'config.memoryHotAddEnabled': String(c.memoryHotAdd),
      'config.memoryReservationLockedToMax': String(c.memoryReservationLockedToMax), 'config.nestedHVEnabled': String(c.nestedHV), 'config.firmware': c.firmware, 'config.defaultPowerOps.standbyAction': c.standbyAction,
      'config.extraConfig': c.extraConfig.map(o => `<OptionValue><key>${esc(o.key)}</key><value xsi:type="xsd:string">${esc(o.value)}</value></OptionValue>`).join('')
    };
  };
  // A VM with no snapshots has no `snapshot` property at all, as on a real host. Children are nested inside their parent's childSnapshotList.
  const snapshotNode = node => `<snapshot type="VirtualMachineSnapshot">${node.id}</snapshot><name>${esc(node.name)}</name><description>${esc(node.description)}</description><createTime>${node.createTime}</createTime><state>${node.state}</state><quiesced>${node.quiesced}</quiesced><backupManifest></backupManifest>${node.children.map(child => `<childSnapshotList>${snapshotNode(child)}</childSnapshotList>`).join('')}`;
  const snapshotXml = vm => vm.snapshots?.length ? `${vm.currentSnapshot ? `<currentSnapshot type="VirtualMachineSnapshot">${vm.currentSnapshot}</currentSnapshot>` : ''}${vm.snapshots.map(root => `<rootSnapshotList>${snapshotNode(root)}</rootSnapshotList>`).join('')}` : null;
  const findSnapshot = (vm, id, list = vm.snapshots ?? [], parent = null) => { for (const node of list) { if (node.id === id) return { node, parent, siblings: list }; const hit = findSnapshot(vm, id, node.children, node); if (hit) return hit; } return null; };
  const ownerOfSnapshot = id => [...state.vms.values()].find(vm => findSnapshot(vm, id));
  const hardwareXml = vm => [
    device('VirtualLsiLogicController', 1000, { label: 'SCSI controller 0', busNumber: 0 }),
    ...vm.disks.map(d => device('VirtualDisk', d.key, { label: d.label, capacityInBytes: d.capacityInBytes, controllerKey: 1000, unitNumber: 0 }, { backing: { type: 'VirtualDiskFlatVer2BackingInfo', fields: { fileName: d.fileName, diskMode: 'persistent', thinProvisioned: true } } })),
    ...vm.nics.map(n => device('VirtualVmxnet3', n.key, { label: n.label, macAddress: n.macAddress }, { backing: { type: 'VirtualEthernetCardNetworkBackingInfo', fields: { deviceName: n.deviceName } }, connectable: n })),
    ...vm.cdroms.map(c => device('VirtualCdrom', c.key, { label: c.label, controllerKey: 200, unitNumber: 0 }, { backing: c.media ? { type: 'VirtualCdromIsoBackingInfo', fields: { fileName: c.media } } : { type: 'VirtualCdromRemoteAtapiBackingInfo', fields: { deviceName: '' } }, connectable: c })),
    device('VirtualMachineVideoCard', 500, { label: 'Video card', videoRamSizeInKB: vm.video?.ramKB ?? 8192, enable3DSupport: vm.video?.enable3d ?? false })
  ].join('');

  const advance = vm => {
    const wait = guestPending.get(vm.id);
    if (!wait) return;
    wait.polls -= 1;
    if (wait.kind === 'shutdown' && wait.polls <= 0) { vm.power = 'poweredOff'; vm.tools = 'guestToolsNotRunning'; vm.uptime = 0; guestPending.delete(vm.id); }
    if (wait.kind === 'reboot') {
      if (wait.polls > 0) vm.tools = 'guestToolsNotRunning';
      else { vm.tools = 'guestToolsRunning'; vm.uptime = 5; guestPending.delete(vm.id); }
    }
  };

  const newTask = (apply, { error = null } = {}) => { const id = `task-${++state.taskSeq}`; state.tasks.set(id, { polls: state.taskPolls, apply, error, done: false }); return id; };

  const sdk = async bodyText => {
    const method = bodyText.match(/<vim25:(\w+)[ >]/)?.[1];
    const injected = faults.http.get(method);
    if (injected) return injected.status === 500 || !injected.status ? fault(injected.message, injected.type) : new Response(injected.message ?? '', { status: injected.status });
    const vmOf = () => state.vms.get(unesc(bodyText.match(/<vim25:_this type="VirtualMachine">([^<]+)<\/vim25:_this>/)?.[1]));
    switch (method) {
      case 'RetrieveServiceContent':
        if (faults.emptyServiceContent) return soap('<RetrieveServiceContentResponse><returnval/></RetrieveServiceContentResponse>');
        return soap('<RetrieveServiceContentResponse><returnval><rootFolder type="Folder">ha-folder-root</rootFolder><propertyCollector type="PropertyCollector">ha-property-collector</propertyCollector><sessionManager type="SessionManager">ha-sessionmgr</sessionManager><viewManager type="ViewManager">ViewManager</viewManager></returnval></RetrieveServiceContentResponse>', { 'set-cookie': 'vmware_soap_session="anon"; Path=/; HttpOnly' });
      case 'Login': {
        const user = unesc(bodyText.match(/<vim25:userName>([^<]*)<\/vim25:userName>/)?.[1]), pass = unesc(bodyText.match(/<vim25:password>([^<]*)<\/vim25:password>/)?.[1]);
        if (user !== username || pass !== password) return fault('Cannot complete login due to an incorrect user name or password.', 'InvalidLogin');
        state.sessions.add('s1'); state.sessionsOpened++;
        return soap('<LoginResponse><returnval><key>s1</key></returnval></LoginResponse>', { 'set-cookie': 'vmware_soap_session="s1"; Path=/; HttpOnly' });
      }
      case 'Logout': state.sessions.clear(); state.sessionsClosed++; return soap('<LogoutResponse/>');
      case 'CreateContainerView': {
        if (!state.sessions.size) return fault('The session is not authenticated.', 'NotAuthenticated');
        const kind = bodyText.match(/<vim25:type>(\w+)<\/vim25:type>/)?.[1];
        return soap(`<CreateContainerViewResponse><returnval type="ContainerView">view-${kind}</returnval></CreateContainerViewResponse>`);
      }
      case 'RetrievePropertiesEx': {
        if (!state.sessions.size) return fault('The session is not authenticated.', 'NotAuthenticated');
        const propType = bodyText.match(/<vim25:propSet><vim25:type>(\w+)<\/vim25:type>/)?.[1], single = bodyText.match(/<vim25:obj type="(VirtualMachine|Task)">([^<]+)<\/vim25:obj>/);
        if (propType === 'Task') {
          const task = state.tasks.get(single[2]);
          if (!task) return fault('The task was not found.', 'ManagedObjectNotFound');
          if (!task.done) { task.polls -= 1; if (task.polls <= 0) { task.done = true; if (!task.error) task.apply(); } }
          const info = task.done ? (task.error ? 'error' : 'success') : 'running';
          return soap(`<RetrievePropertiesExResponse><returnval>${objectXml('Task', single[2], { 'info.state': info, 'info.error': task.error && task.done ? `<localizedMessage>${esc(task.error)}</localizedMessage>` : null })}</returnval></RetrievePropertiesExResponse>`);
        }
        if (propType === 'VirtualMachine' && single?.[1] === 'VirtualMachine') {
          const vm = state.vms.get(unesc(single[2]));
          if (!vm) return fault('The object has already been deleted or has not been completely created', 'ManagedObjectNotFound');
          advance(vm);
          const wanted = [...bodyText.matchAll(/<vim25:pathSet>([^<]+)<\/vim25:pathSet>/g)].map(m => m[1]), all = vmProps(vm);
          return soap(`<RetrievePropertiesExResponse><returnval>${objectXml('VirtualMachine', vm.id, Object.fromEntries(wanted.map(name => [name, all[name]])))}</returnval></RetrievePropertiesExResponse>`);
        }
        if (propType === 'VirtualMachine') {
          const list = [...state.vms.values()], page = list.slice(0, pageSize);
          return soap(`<RetrievePropertiesExResponse><returnval>${list.length > pageSize ? `<token>vm-page-1</token>` : ''}${page.map(vm => objectXml('VirtualMachine', vm.id, vmProps(vm))).join('')}</returnval></RetrievePropertiesExResponse>`);
        }
        if (propType === 'Datastore') return soap(`<RetrievePropertiesExResponse><returnval>${Object.keys(state.isos).map((name, i) => objectXml('Datastore', `datastore-${i + 1}`, { name })).join('')}</returnval></RetrievePropertiesExResponse>`);
        if (propType === 'HostSystem') return soap(`<RetrievePropertiesExResponse><returnval>${state.hostName ? objectXml('HostSystem', 'ha-host', { name: state.hostName }) : ''}</returnval></RetrievePropertiesExResponse>`);
        return fault(`Unsupported property query for ${propType}.`);
      }
      case 'ContinueRetrievePropertiesEx': {
        const token = bodyText.match(/<vim25:token>([^<]+)<\/vim25:token>/)?.[1], list = [...state.vms.values()], pageNo = Number(token.split('-').pop());
        const page = list.slice(pageNo * pageSize, (pageNo + 1) * pageSize);
        return soap(`<ContinueRetrievePropertiesExResponse><returnval>${list.length > (pageNo + 1) * pageSize ? `<token>vm-page-${pageNo + 1}</token>` : ''}${page.map(vm => objectXml('VirtualMachine', vm.id, vmProps(vm))).join('')}</returnval></ContinueRetrievePropertiesExResponse>`);
      }
      case 'PowerOnVM_Task': case 'PowerOffVM_Task': case 'ResetVM_Task': case 'SuspendVM_Task': {
        const vm = vmOf();
        if (!vm) return fault('The object has already been deleted or has not been completely created', 'ManagedObjectNotFound');
        const [needs, next] = { PowerOnVM_Task: ['poweredOff|suspended', 'poweredOn'], PowerOffVM_Task: ['poweredOn|suspended', 'poweredOff'], ResetVM_Task: ['poweredOn', 'poweredOn'], SuspendVM_Task: ['poweredOn', 'suspended'] }[method];
        const allowed = needs.split('|').includes(vm.power);
        const id = newTask(() => { vm.power = next; vm.tools = next === 'poweredOn' ? 'guestToolsRunning' : 'guestToolsNotRunning'; vm.uptime = next === 'poweredOn' ? 5 : 0; }, { error: allowed ? null : 'The operation is not allowed in the current state of the virtual machine.' });
        return soap(`<${method}Response><returnval type="Task">${id}</returnval></${method}Response>`);
      }
      case 'ShutdownGuest': case 'RebootGuest': {
        const vm = vmOf();
        if (!vm) return fault('The object has already been deleted or has not been completely created', 'ManagedObjectNotFound');
        if (vm.power !== 'poweredOn') return fault('The operation is not allowed in the current state.', 'InvalidPowerState');
        if (vm.tools !== 'guestToolsRunning') return fault('Cannot complete operation because VMware Tools is not running in this virtual machine.', 'ToolsUnavailable');
        if (!state.guestIgnoresRequests) guestPending.set(vm.id, { kind: method === 'ShutdownGuest' ? 'shutdown' : 'reboot', polls: method === 'ShutdownGuest' ? state.shutdownPolls : state.rebootPolls });
        return soap(`<${method}Response/>`);
      }
      case 'AcquireTicket': {
        const vm = vmOf();
        if (!vm) return fault('The object has already been deleted or has not been completely created', 'ManagedObjectNotFound');
        return soap(vm.noTicket ? '<AcquireTicketResponse><returnval/></AcquireTicketResponse>' : `<AcquireTicketResponse><returnval><ticket>cst-${vm.id}</ticket><host>${state.hostName}</host><port>443</port></returnval></AcquireTicketResponse>`);
      }
      case 'CreateSnapshot_Task': {
        const vm = vmOf();
        if (!vm) return fault('The object has already been deleted or has not been completely created', 'ManagedObjectNotFound');
        if (vm.snapshotsSupported === false) return fault('The operation is not supported on the object.', 'NotSupported');
        const field = name => unesc(bodyText.match(new RegExp(`<vim25:${name}>([^<]*)</vim25:${name}>`))?.[1] ?? ''), memory = field('memory') === 'true';
        const id = newTask(() => {
          const node = { id: `snapshot-${++state.snapshotSeq}`, name: field('name'), description: field('description'), createTime: new Date(Date.UTC(2026, 9, 7, 12, 0, state.snapshotSeq)).toISOString(), state: memory && vm.power === 'poweredOn' ? 'poweredOn' : 'poweredOff', quiesced: field('quiesce') === 'true', children: [] };
          const parent = vm.currentSnapshot ? findSnapshot(vm, vm.currentSnapshot).node : null;
          (parent ? parent.children : (vm.snapshots ??= [])).push(node);
          vm.currentSnapshot = node.id;
        });
        return soap(`<CreateSnapshot_TaskResponse><returnval type="Task">${id}</returnval></CreateSnapshot_TaskResponse>`);
      }
      case 'RevertToSnapshot_Task': case 'RemoveSnapshot_Task': {
        const snapshotId = unesc(bodyText.match(/<vim25:_this type="VirtualMachineSnapshot">([^<]+)<\/vim25:_this>/)?.[1]), vm = ownerOfSnapshot(snapshotId);
        if (!vm) return fault('The object has already been deleted or has not been completely created', 'ManagedObjectNotFound');
        const id = newTask(() => {
          if (method === 'RevertToSnapshot_Task') { vm.currentSnapshot = snapshotId; return; }
          const { node, parent, siblings } = findSnapshot(vm, snapshotId);        // removing a snapshot hands its children to its parent
          siblings.splice(siblings.indexOf(node), 1, ...node.children);
          if (vm.currentSnapshot === snapshotId) vm.currentSnapshot = parent?.id ?? null;
          if (!vm.snapshots.length) vm.currentSnapshot = null;
        }, { error: vm.snapshotTaskError ?? null });
        return soap(`<${method}Response><returnval type="Task">${id}</returnval></${method}Response>`);
      }
      case 'QueryConfigTarget':
        return soap('<QueryConfigTargetResponse><returnval><network><network type="Network">network-1</network><name>VM Network</name></network><network><network type="Network">network-2</network><name>Storage Network</name></network><datastore><datastore type="Datastore">datastore-1</datastore><name>datastore1</name></datastore></returnval></QueryConfigTargetResponse>');
      case 'ReconfigVM_Task': {
        const vm = vmOf();
        if (!vm) return fault('The object has already been deleted or has not been completely created', 'ManagedObjectNotFound');
        const spec = bodyText.slice(bodyText.indexOf('<vim25:spec>')), changes = [...spec.matchAll(/<vim25:deviceChange>([\s\S]*?)<\/vim25:deviceChange>/g)].map(m => m[1]), scalarXml = spec.replace(/<vim25:deviceChange>[\s\S]*?<\/vim25:deviceChange>/g, '');
        const scalar = name => { const hit = scalarXml.match(new RegExp(`<vim25:${name}>([^<]*)</vim25:${name}>`)); return hit ? unesc(hit[1]) : undefined; };
        const cfg = configOf(vm), sent = scalar('changeVersion');
        if (sent !== undefined && sent !== cfg.changeVersion) return fault('The configuration of the virtual machine has changed since the operation started.', 'ConcurrentAccess');
        for (const change of changes) {                                  // every device must exist before anything is applied
          const op = change.match(/<vim25:operation>(\w+)<\/vim25:operation>/)?.[1], key = Number(change.match(/<vim25:key>(-?\d+)<\/vim25:key>/)?.[1]);
          if ((op === 'edit' || op === 'remove') && ![...vm.disks, ...vm.nics, ...vm.cdroms].some(d => d.key === key) && key !== 500) return fault('A specified parameter was not correct: spec.deviceChange.device', 'InvalidDeviceSpec');
        }
        const id = newTask(() => {
          vm.config = { ...vm.config };
          const set = (field, value) => { if (value !== undefined) vm.config[field] = value; }, flag = value => value === undefined ? undefined : value === 'true';
          if (scalar('name') !== undefined) vm.name = scalar('name');
          set('annotation', scalar('annotation'));
          if (scalar('numCPUs') !== undefined) vm.cpu = Number(scalar('numCPUs'));
          set('coresPerSocket', scalar('numCoresPerSocket') === undefined ? undefined : Number(scalar('numCoresPerSocket')));
          if (scalar('memoryMB') !== undefined) vm.memoryMB = Number(scalar('memoryMB'));
          set('firmware', scalar('firmware')); set('standbyAction', scalar('standbyAction')); set('cpuHotAdd', flag(scalar('cpuHotAddEnabled'))); set('memoryHotAdd', flag(scalar('memoryHotAddEnabled'))); set('nestedHV', flag(scalar('nestedHVEnabled')));
          if (/<vim25:extraConfig>/.test(scalarXml)) {
            const extra = new Map((cfg.extraConfig).map(o => [o.key, o.value]));
            for (const m of scalarXml.matchAll(/<vim25:extraConfig><vim25:key>([^<]*)<\/vim25:key><vim25:value[^>]*>([^<]*)<\/vim25:value><\/vim25:extraConfig>/g)) { if (m[2] === '') extra.delete(unesc(m[1])); else extra.set(unesc(m[1]), unesc(m[2])); }
            vm.config.extraConfig = [...extra].map(([key, value]) => ({ key, value }));
          }
          let nextKey = 5000;
          for (const change of changes) {
            const op = change.match(/<vim25:operation>(\w+)<\/vim25:operation>/)?.[1], type = change.match(/<vim25:device xsi:type="vim25:(\w+)"/)?.[1], key = Number(change.match(/<vim25:key>(-?\d+)<\/vim25:key>/)?.[1]);
            const field = name => change.match(new RegExp(`<vim25:${name}>([^<]*)</vim25:${name}>`))?.[1];
            const connected = /<vim25:connected>true<\/vim25:connected>/.test(change), start = /<vim25:startConnected>true<\/vim25:startConnected>/.test(change);
            if (op === 'remove') { vm.disks = vm.disks.filter(d => d.key !== key); vm.nics = vm.nics.filter(d => d.key !== key); vm.cdroms = vm.cdroms.filter(d => d.key !== key); continue; }
            if (op === 'add' && /Vmxnet|E1000|Ethernet/.test(type)) { vm.nics.push({ key: nextKey++, label: `Network adapter ${vm.nics.length + 1}`, macAddress: `00:0c:29:aa:bb:${String(vm.nics.length).padStart(2, '0')}`, deviceName: unesc(field('deviceName') ?? ''), connected, startConnected: start }); continue; }
            if (op === 'add' && type === 'VirtualCdrom') { vm.cdroms.push({ key: nextKey++, label: `CD/DVD drive ${vm.cdroms.length + 1}`, media: null, connected: false, startConnected: false }); continue; }
            if (op !== 'edit') continue;
            if (type === 'VirtualDisk') vm.disks.find(d => d.key === key).capacityInBytes = Number(field('capacityInKB')) * 1024;
            else if (type === 'VirtualCdrom') { const drive = vm.cdroms.find(c => c.key === key), iso = change.match(/<vim25:fileName>([^<]*)<\/vim25:fileName>/)?.[1]; drive.media = iso ? unesc(iso) : null; drive.connected = connected; drive.startConnected = start; }
            else if (type === 'VirtualMachineVideoCard') vm.video = { ramKB: Number(field('videoRamSizeInKB')), enable3d: field('enable3DSupport') === 'true' };
            else { const nic = vm.nics.find(n => n.key === key); nic.deviceName = unesc(field('deviceName') ?? nic.deviceName); nic.connected = connected; nic.startConnected = start; }
          }
          vm.config.changeVersion = `2026-10-07T00:00:${String(++state.configSeq).padStart(2, '0')}.000Z`;
        }, { error: vm.reconfigError ?? null });
        return soap(`<ReconfigVM_TaskResponse><returnval type="Task">${id}</returnval></ReconfigVM_TaskResponse>`);
      }
      default: return fault(`The fake ESXi does not implement ${method}.`);
    }
  };

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), body = init.body ? String(init.body) : '';
    const method = url.pathname === '/sdk' ? body.match(/<vim25:(\w+)[ >]/)?.[1] : init.method ?? 'GET';
    calls.push({ http: init.method ?? 'GET', path: url.pathname, method, body: body.slice(0, 30000) });
    if (faults.unreachable) throw new TypeError('fetch failed: ECONNREFUSED');
    if (url.pathname === '/sdk') return sdk(body);
    if (url.pathname.startsWith('/folder/')) return datastoreFolderResponse(state.isos, url);
    return new Response('not found', { status: 404 });
  };

  return { fetch: fetchImpl, state, calls, faults, soapCalls: () => calls.filter(c => c.path === '/sdk').map(c => c.method), openSessions: () => state.sessionsOpened - state.sessionsClosed };
}
