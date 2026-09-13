const deviceLists=['disks','networkAdapters','cdDvdDrives','videoCards','controllers','additionalDevices'];

const usableList=value=>Array.isArray(value)&&value.length>0;
const copy=value=>structuredClone(value);
const configurableController=controller=>/SCSI|LsiLogic|ParaVirtual|AHCI|SATA|NVME|USB/i.test(String(controller?.type));
const configurableAdditionalDevice=device=>/Sound|Audio|Floppy|Serial|Parallel|TPM/i.test(String(device?.type));

export function mergeVmSettingsInventory(result,resource){
  if(!result?.settings)return result;
  const cached=resource?.providerMetadata?.hardware;
  if(!cached||typeof cached!=='object')return result;
  const settings={...result.settings},direct=settings.hardware??{},hardware={...direct};
  if(usableList(direct.controllers))hardware.controllers=copy(direct.controllers.filter(configurableController));
  if(usableList(direct.additionalDevices))hardware.additionalDevices=copy(direct.additionalDevices.filter(configurableAdditionalDevice));
  for(const key of deviceLists){
    if(usableList(direct[key]))continue;
    if(usableList(cached[key]))hardware[key]=copy(key==='controllers'?cached[key].filter(configurableController):cached[key]);
  }
  if(!usableList(hardware.controllers)&&usableList(cached.usbControllers)){
    hardware.controllers=copy(cached.usbControllers).map((controller,index)=>({
      ...controller,
      id:String(controller.id??`cached-usb-${index}`),
      label:controller.label??`USB controller ${index+1}`,
      type:controller.type??'VirtualUSBController',
      busNumber:controller.busNumber??0,
      busSharing:controller.busSharing??'noSharing'
    }));
  }
  settings.hardware=hardware;
  return {...result,settings};
}
