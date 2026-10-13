export class ReadinessService{
  /* requiredMigration is the newest migration that ships with this build (see migrations.js). The platform is ready only when the database has recorded it in
     platform.schema_migrations, which every migration from 0029 on does for itself. */
  constructor({production,store,broker,worker,agentMaintenance,requiredMigration}){
    if(!/^\d{4}$/.test(requiredMigration??''))throw new Error('ReadinessService needs the required migration version (four digits).');
    this.production=production;this.store=store;this.broker=broker;this.worker=worker;this.agentMaintenance=agentMaintenance;this.requiredMigration=requiredMigration;
  }
  async check(){
    const components={database:'healthy',broker:this.broker.status??'unknown',worker:this.worker.status,agentMaintenance:this.agentMaintenance.timer?'healthy':'stopped'},issues=[];
    if(this.production){
      try{
        await this.store.pool.query('SELECT 1');this.store.status='healthy';
        const recorded=(await this.store.pool.query('SELECT max(version) AS version FROM platform.schema_migrations')).rows[0]?.version??null;
        if(!recorded||recorded<this.requiredMigration){components.migrations='outdated';issues.push(`Required migration ${this.requiredMigration} is not applied (newest recorded: ${recorded??'none'}).`);}
        else components.migrations='current';
      }catch{this.store.status='unhealthy';components.database='unhealthy';issues.push('Database readiness check failed.');}
    }
    if(components.broker!=='healthy')issues.push('Task broker is not healthy.');
    if(components.worker!=='healthy')issues.push('Worker is not healthy.');
    if(components.agentMaintenance!=='healthy')issues.push('Agent maintenance scheduler is not running.');
    return {status:issues.length?'not_ready':'ready',components,issues};
  }
}
