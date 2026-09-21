const parts=value=>String(value??'0.0.0').replace(/^v/,'').split(/[.-]/).slice(0,3).map(x=>Number(x)||0);
export function compareVersions(left,right){const a=parts(left),b=parts(right);for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;}
export class AgentCompatibilityPolicy{
  constructor({minimumVersion='0.1.0',recommendedVersion='0.1.0'}={}){this.minimumVersion=minimumVersion;this.recommendedVersion=recommendedVersion;}
  evaluate(version){const compatible=compareVersions(version,this.minimumVersion)>=0,upgradeAvailable=compareVersions(version,this.recommendedVersion)<0;return {compatible,upgradeRequired:!compatible,upgradeAvailable,minimumVersion:this.minimumVersion,recommendedVersion:this.recommendedVersion,agentVersion:version};}
}
