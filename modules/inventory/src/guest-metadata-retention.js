const present=value=>value!==null&&value!==undefined&&String(value).trim()!=='';
const toolsKeys=['toolsRunningStatus','toolsStatus','vmwareTools'];
const toolsEntry=metadata=>toolsKeys.map(key=>[key,metadata?.[key]]).find(([,value])=>present(value))??[null,null];

export function retainLastPoweredOnGuestMetadata(priorResource,item){
  const current=structuredClone(item.providerMetadata??{});
  if(item.resourceType!=='virtual_machine')return current;
  const prior=priorResource?.providerMetadata??{},powerState=item.attributes?.powerState??'unknown',priorPowerState=priorResource?.attributes?.powerState??'unknown';
  const [currentToolsKey,currentToolsValue]=toolsEntry(current),[priorToolsKey,priorToolsValue]=toolsEntry(prior);
  let lastHostName=prior.lastPoweredOnHostName??(priorPowerState==='running'&&present(prior.hostName)?prior.hostName:null);
  let lastToolsStatus=prior.lastPoweredOnToolsStatus??(priorPowerState==='running'&&present(priorToolsValue)?priorToolsValue:null);

  if(powerState==='running'){
    if(present(current.hostName))lastHostName=current.hostName;
    else if(present(lastHostName)){current.hostName=lastHostName;current.hostNameRetained=true;}
    if(present(currentToolsValue))lastToolsStatus=currentToolsValue;
    else if(present(lastToolsStatus)){current[currentToolsKey??priorToolsKey??'toolsStatus']=lastToolsStatus;current.toolsStatusRetained=true;}
  }else{
    if(!present(current.hostName)&&present(lastHostName)){current.hostName=lastHostName;current.hostNameRetained=true;}
    if(present(lastToolsStatus)){current[currentToolsKey??priorToolsKey??'toolsStatus']=lastToolsStatus;current.toolsStatusRetained=true;}
  }

  if(present(lastHostName))current.lastPoweredOnHostName=lastHostName;
  if(present(lastToolsStatus))current.lastPoweredOnToolsStatus=lastToolsStatus;
  if(current.hostNameRetained||current.toolsStatusRetained){
    current.reporting={...(current.reporting??{}),...(current.hostNameRetained?{hostname:'Last reported while the VM was powered on.'}:{}),...(current.toolsStatusRetained?{tools:'Last reported while the VM was powered on.'}:{})};
  }
  return current;
}
