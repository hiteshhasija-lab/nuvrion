const htmlEntity=value=>String(value).replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#39;',"'").replace(/&#(\d+);/g,(_,code)=>String.fromCharCode(Number(code)));

export function normalizeDatastoreIsoPath(value){
  const text=String(value??'').trim();
  if(text.length>1200||/[\u0000-\u001f\u007f]/.test(text))throw Object.assign(new Error('Select a valid datastore ISO path.'),{code:'NUV_MEDIA_PATH_INVALID',status:422});
  const match=text.match(/^\[([^\]\r\n]{1,128})\]\s+([^\r\n]+\.iso)$/i);
  if(!match||match[2].split(/[\\/]/).includes('..'))throw Object.assign(new Error('Use a datastore ISO path such as [datastore1] images/server.iso.'),{code:'NUV_MEDIA_PATH_INVALID',status:422});
  const datastore=match[1].trim(),path=match[2].replaceAll('\\','/').replace(/^\/+/, '').replace(/\/{2,}/g,'/');
  if(!datastore||!path)throw Object.assign(new Error('Select a valid datastore ISO path.'),{code:'NUV_MEDIA_PATH_INVALID',status:422});
  return {datastore,path,isoPath:`[${datastore}] ${path}`};
}

export async function browseDatastoreIsoFiles({base,credential,datastores,datacenter=null,fetchImpl=fetch,timeoutMs=15000,maxDirectories=80,maxImages=500}){
  const images=new Set(),warnings=[],authorization=`Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`;
  for(const datastore of datastores.slice(0,32)){
    const name=String(datastore.name??datastore).trim();if(!name)continue;
    const start=new URL('/folder/',base);start.searchParams.set('dsName',name);if(datacenter)start.searchParams.set('dcPath',datacenter);
    const queue=[start],visited=new Set();
    while(queue.length&&visited.size<maxDirectories&&images.size<maxImages){
      const current=queue.shift(),key=current.href;if(visited.has(key))continue;visited.add(key);
      let response;try{response=await fetchImpl(current,{headers:{accept:'text/html,application/xhtml+xml',authorization},signal:AbortSignal.timeout(timeoutMs)});}catch(error){warnings.push({datastore:name,code:'NUV_MEDIA_BROWSE_UNREACHABLE',detail:error.message});break;}
      if(!response.ok){warnings.push({datastore:name,code:response.status===403?'NUV_MEDIA_BROWSE_PERMISSION_DENIED':'NUV_MEDIA_BROWSE_FAILED',detail:`Datastore browser returned HTTP ${response.status}.`});break;}
      const html=await response.text(),links=[...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(match=>htmlEntity(match[1]));
      for(const href of links){
        if(!href||href.startsWith('#')||href.startsWith('javascript:'))continue;
        let target;try{target=new URL(href,current);}catch{continue;}
        if(target.origin!==start.origin||!target.pathname.startsWith('/folder/'))continue;
        target.searchParams.set('dsName',name);if(datacenter)target.searchParams.set('dcPath',datacenter);
        let relative;try{relative=decodeURIComponent(target.pathname.slice('/folder/'.length)).replace(/^\/+/, '');}catch{continue;}
        if(!relative||relative.split('/').includes('..'))continue;
        if(relative.toLowerCase().endsWith('.iso')){images.add(`[${name}] ${relative}`);continue;}
        if(target.pathname.endsWith('/')&&!visited.has(target.href))queue.push(target);
      }
    }
    if(visited.size>=maxDirectories)warnings.push({datastore:name,code:'NUV_MEDIA_BROWSE_LIMIT',detail:`ISO discovery stopped after ${maxDirectories} folders.`});
  }
  return {images:[...images].sort((a,b)=>a.localeCompare(b)),warnings};
}

export function cdromInfo(id,detail={}){
  const backing=detail.backing??{},state=detail.state??detail.connection_state??detail.connectionState;
  return {id:String(detail.cdrom??detail.id??id),label:detail.label??`CD/DVD drive ${id}`,media:backing.iso_file??backing.isoFile??null,backingType:backing.type??null,connected:state==null?null:String(state).toUpperCase()==='CONNECTED'||state===true,startConnected:detail.start_connected??detail.startConnected??null,allowGuestControl:detail.allow_guest_control??detail.allowGuestControl??null};
}
