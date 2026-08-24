import {verifyAgentCommand} from '../../../modules/agents/src/agent-registry.js';
export class AgentRuntimeError extends Error{constructor(code,message){super(message);this.code=code;}}
export class WorkstationAgentRuntime{
  #seen=new Set();
  constructor({agentId,secret,executor,clock=()=>Date.now()}){this.agentId=agentId;this.secret=secret;this.executor=executor;this.clock=clock;}
  heartbeat({version,inventory}){return {agentId:this.agentId,version,inventory,observedAt:new Date(this.clock()).toISOString()};}
  async accept(envelope){const payload=envelope?.payload;if(!payload||payload.agentId!==this.agentId)throw new AgentRuntimeError('NUV_AGENT_COMMAND_WRONG_RECIPIENT','Command was issued to another agent.');if(!verifyAgentCommand(this.secret,envelope))throw new AgentRuntimeError('NUV_AGENT_COMMAND_TAMPERED','Command signature is invalid.');if(Date.parse(payload.expiresAt)<=this.clock())throw new AgentRuntimeError('NUV_AGENT_COMMAND_EXPIRED','Command has expired.');if(this.#seen.has(payload.commandId))throw new AgentRuntimeError('NUV_AGENT_COMMAND_REPLAYED','Command was already processed.');this.#seen.add(payload.commandId);try{return {commandId:payload.commandId,status:'completed',result:await this.executor.execute(payload.operation,payload.targetId)};}catch(error){return {commandId:payload.commandId,status:'failed',result:{code:error.code??'NUV_AGENT_EXECUTION_FAILED',message:error.message}};}}
}
