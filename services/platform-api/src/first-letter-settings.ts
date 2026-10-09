import type {PoolClient} from 'pg';
import {agendaLocalDate} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {Database} from './database.ts';
import type {PlatformConfig} from './config.ts';
import type {CompanionDailySettingsService} from './companion-daily-settings.ts';
import {snapshotFirstLetterSettings} from './first-letter-composition.ts';
import {parseExpertRelease} from './expert-release.ts';
import {ApiError} from './errors.ts';
/** Uses the saved owner preference and database clock. Neither browser time
 * nor a client/Redis roster is accepted as authority. */
export class FirstLetterSettings{
 private readonly release;
 constructor(private readonly db:Database,private readonly daily:Pick<CompanionDailySettingsService,'readForPolicyInTransaction'>,
  config:Pick<PlatformConfig,'expertRoster'>){this.release=config.expertRoster===undefined?undefined:parseExpertRelease(config.expertRoster);}
 async readInTransaction(c:PoolClient,who:FixedSessionContext,signal?:AbortSignal){
  const own=await this.daily.readForPolicyInTransaction(c,who,signal);
  if(own.ownerId!==who.userId||!own.preferences)throw new ApiError(503,'FIRST_LETTER_SETTINGS_UNAVAILABLE','The letter settings could not be confirmed.');
  if(!this.release)throw new ApiError(503,'FIRST_LETTER_RELEASE_UNAVAILABLE','The released expert list has not been configured.');
  const at=(await c.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();
  const settings=snapshotFirstLetterSettings({rosterRevision:this.release.revision,enabledExperts:this.release.enabledExperts,
   localDate:agendaLocalDate(at,own.preferences.timeZone)});
  await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();return settings;
 }
 async read(who:FixedSessionContext,signal?:AbortSignal){
  const fixed=Object.freeze({...who});return this.db.withBoundedTransaction(c=>this.readInTransaction(c,fixed,signal));
 }
}
