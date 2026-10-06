// A line carrying this marker is a deliberate, reviewed fixture (for example a fake password in a test) and is not reported.
export const ALLOW_MARKER='secret-scan:allow';
const rules=[
  {id:'private-key',pattern:/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/},
  {id:'aws-access-key',pattern:/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/},
  {id:'credential-url',pattern:/(?:postgres(?:ql)?|amqps?):\/\/[^\s:@/]+:[^\s@/<>{}]+@/i},
  {id:'assigned-secret',pattern:/(?:password|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"]{12,}['"]/i}
];
export function scanTextForSecrets(text,{path='unknown'}={}){const findings=[];for(const [index,line] of String(text).split(/\r?\n/).entries())if(!line.includes(ALLOW_MARKER))for(const rule of rules)if(rule.pattern.test(line))findings.push({ruleId:rule.id,path,line:index+1});return findings;}
export function evaluateSecretScan(files){return files.flatMap(file=>scanTextForSecrets(file.text,{path:file.path}));}
