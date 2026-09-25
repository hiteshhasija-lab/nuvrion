import {createHash} from 'node:crypto';
import {connect as tlsConnect} from 'node:tls';
import {request as httpRequest} from 'node:http';
import {isIP} from 'node:net';
import {Client as SshClient} from 'ssh2';

export function probeSshHostKeyFingerprint(hostname,port=22){
  return new Promise(resolve=>{
    let fingerprint=null,settled=false;
    const client=new SshClient(),finish=()=>{if(settled)return;settled=true;client.end();resolve(fingerprint);};
    client.on('ready',finish).on('error',finish).connect({host:hostname,port,username:'nuvrion-host-key-probe',password:'nuvrion-host-key-probe',readyTimeout:5000,hostVerifier:key=>{fingerprint=`SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/,'')}`;return true;}});
    setTimeout(finish,6000).unref();
  });
}

export function probeTlsCertificateFingerprint(hostname,port=443){
  return new Promise(resolve=>{
    let settled=false;
    const finish=value=>{if(settled)return;settled=true;socket.destroy();resolve(value);};
    const socket=tlsConnect({host:hostname,port,...(isIP(hostname)?{}:{servername:hostname}),rejectUnauthorized:false},()=>{
      const cert=socket.getPeerCertificate();
      finish(cert?.fingerprint256??null);
    });
    socket.on('error',()=>finish(null));
    setTimeout(()=>finish(null),6000).unref();
  });
}

// Certificate pinning: the peer's certificate is verified against `pinnedFingerprint256`
// (Node's `fingerprint256`, e.g. "AA:BB:...") BEFORE any HTTP request is ever sent over the
// socket. `rejectUnauthorized:false` only disables the default CA-chain check so a pinned
// self-signed certificate can be used at all -- `checkServerIdentity` errors are NOT enforced
// by Node when `rejectUnauthorized` is false, so verification is done manually here instead,
// pre-connect, rather than relying on that callback.
export function createPinnedFetch(pinnedFingerprint256){
  return (url,init={})=>new Promise((resolve,reject)=>{
    const target=url instanceof URL?url:new URL(url),bodyBuffer=init.body!=null?Buffer.from(init.body):undefined,headers={...(init.headers||{})};
    if(bodyBuffer)headers['content-length']=bodyBuffer.length;
    const socket=tlsConnect({host:target.hostname,port:Number(target.port)||443,...(isIP(target.hostname)?{}:{servername:target.hostname}),rejectUnauthorized:false});
    let settled=false;
    const fail=error=>{if(settled)return;settled=true;socket.destroy();reject(error);};
    if(init.signal){
      if(init.signal.aborted)return fail(new Error('The operation was aborted.'));
      init.signal.addEventListener('abort',()=>fail(new Error('The operation was aborted.')),{once:true});
    }
    socket.once('error',fail);
    socket.once('secureConnect',()=>{
      const cert=socket.getPeerCertificate(),actual=cert?.fingerprint256;
      if(!actual||actual!==pinnedFingerprint256)return fail(new Error(`The TLS certificate presented by ${target.hostname} does not match the pinned fingerprint for this connection.`));
      const req=httpRequest({path:`${target.pathname}${target.search}`,method:init.method||'GET',headers,createConnection:()=>socket},res=>{
        if(settled)return;
        const chunks=[];
        res.on('data',chunk=>chunks.push(chunk));
        res.on('end',()=>{
          settled=true;
          const buf=Buffer.concat(chunks),setCookieHeader=res.headers['set-cookie'];
          resolve({
            ok:res.statusCode>=200&&res.statusCode<300,
            status:res.statusCode,
            text:async()=>buf.toString('utf8'),
            headers:{
              get:name=>{const v=res.headers[String(name).toLowerCase()];return Array.isArray(v)?v[0]??null:v??null;},
              getSetCookie:()=>Array.isArray(setCookieHeader)?setCookieHeader:(setCookieHeader?[setCookieHeader]:[]),
            },
          });
        });
      });
      req.on('error',fail);
      req.end(bodyBuffer);
    });
  });
}
