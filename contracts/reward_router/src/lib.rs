#![no_std]
//! reward_router — stores each developer's reward-routing preferences on-chain.
//!
//! The AutoFi service reads these (via `has_preferences` / `get_preferences`)
//! to decide what share of every incoming reward to off-ramp, and through
//! which anchor asset. Only the developer can change their own preferences.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, String,
};

/// ~30 days at 5s ledgers. Preferences are re-extended on every write/read.
const TTL_THRESHOLD: u32 = 17_280 * 7;
const TTL_EXTEND_TO: u32 = 17_280 * 30;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoutePreferences {
    pub off_ramp_pct: u32,         // percentage to off-ramp (0-100)
    pub keep_crypto_pct: u32,      // percentage to keep as crypto (0-100)
    pub anchor_asset_code: String, // e.g. "NGNX", "USDC", "GBPT"
    pub anchor_issuer: Address,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Prefs(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidSplit = 1,
    NotFound = 2,
    InvalidAssetCode = 3,
}

/// Emitted when a user creates or updates their preferences.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreferencesSet {
    #[topic]
    pub user: Address,
    pub prefs: RoutePreferences,
}

/// Emitted when a user deletes their preferences.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreferencesRemoved {
    #[topic]
    pub user: Address,
}

#[contract]
pub struct RewardRouter;

#[contractimpl]
impl RewardRouter {
    /// Create or replace the caller's preferences. Requires the user's signature.
    pub fn set_preferences(env: Env, user: Address, prefs: RoutePreferences) -> Result<(), Error> {
        user.require_auth();
        validate(&prefs)?;

        let key = DataKey::Prefs(user.clone());
        env.storage().persistent().set(&key, &prefs);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        PreferencesSet { user, prefs }.publish(&env);
        Ok(())
    }

    /// Fails with `Error::NotFound` if the user has no preferences.
    pub fn get_preferences(env: Env, user: Address) -> Result<RoutePreferences, Error> {
        let key = DataKey::Prefs(user);
        let prefs: RoutePreferences = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(prefs)
    }

    pub fn has_preferences(env: Env, user: Address) -> bool {
        env.storage().persistent().has(&DataKey::Prefs(user))
    }

    /// Delete the caller's preferences (AutoFi will then stop routing their rewards).
    pub fn remove_preferences(env: Env, user: Address) -> Result<(), Error> {
        user.require_auth();
        let key = DataKey::Prefs(user.clone());
        if !env.storage().persistent().has(&key) {
            return Err(Error::NotFound);
        }
        env.storage().persistent().remove(&key);
        PreferencesRemoved { user }.publish(&env);
        Ok(())
    }
}

fn validate(prefs: &RoutePreferences) -> Result<(), Error> {
    // Check each bound before adding so huge values can't overflow.
    if prefs.off_ramp_pct > 100
        || prefs.keep_crypto_pct > 100
        || prefs.off_ramp_pct + prefs.keep_crypto_pct != 100
    {
        return Err(Error::InvalidSplit);
    }
    let len = prefs.anchor_asset_code.len();
    if len == 0 || len > 12 {
        return Err(Error::InvalidAssetCode);
    }
    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, String};

    fn setup() -> (Env, RewardRouterClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(RewardRouter, ());
        let client = RewardRouterClient::new(&env, &contract_id);
        let user = Address::generate(&env);
        (env, client, user)
    }

    fn prefs(env: &Env, off: u32, keep: u32, code: &str) -> RoutePreferences {
        RoutePreferences {
            off_ramp_pct: off,
            keep_crypto_pct: keep,
            anchor_asset_code: String::from_str(env, code),
            anchor_issuer: Address::generate(env),
        }
    }

    #[test]
    fn set_and_get_preferences() {
        let (env, client, user) = setup();
        assert!(!client.has_preferences(&user));

        let p = prefs(&env, 70, 30, "NGNX");
        client.set_preferences(&user, &p);

        assert!(client.has_preferences(&user));
        assert_eq!(client.get_preferences(&user), p);
    }

    #[test]
    fn set_requires_user_auth() {
        let (env, client, user) = setup();
        client.set_preferences(&user, &prefs(&env, 100, 0, "USDC"));
        let auths = env.auths();
        assert_eq!(auths.len(), 1);
        assert_eq!(auths[0].0, user);
    }

    #[test]
    fn invalid_split_is_rejected() {
        let (env, client, user) = setup();
        let res = client.try_set_preferences(&user, &prefs(&env, 80, 30, "USDC"));
        assert_eq!(res, Err(Ok(Error::InvalidSplit)));
    }

    #[test]
    fn overflowing_split_is_rejected() {
        let (env, client, user) = setup();
        let res = client.try_set_preferences(&user, &prefs(&env, u32::MAX, 101, "USDC"));
        assert_eq!(res, Err(Ok(Error::InvalidSplit)));
    }

    #[test]
    fn invalid_asset_code_is_rejected() {
        let (env, client, user) = setup();
        let res = client.try_set_preferences(&user, &prefs(&env, 50, 50, ""));
        assert_eq!(res, Err(Ok(Error::InvalidAssetCode)));
        let res = client.try_set_preferences(&user, &prefs(&env, 50, 50, "WAYTOOLONGCODE"));
        assert_eq!(res, Err(Ok(Error::InvalidAssetCode)));
    }

    #[test]
    fn get_missing_returns_not_found() {
        let (_env, client, user) = setup();
        assert_eq!(client.try_get_preferences(&user), Err(Ok(Error::NotFound)));
    }

    #[test]
    fn remove_preferences_works() {
        let (env, client, user) = setup();
        client.set_preferences(&user, &prefs(&env, 60, 40, "GBPT"));
        client.remove_preferences(&user);
        assert!(!client.has_preferences(&user));
        assert_eq!(
            client.try_remove_preferences(&user),
            Err(Ok(Error::NotFound))
        );
    }

    #[test]
    fn users_are_isolated() {
        let (env, client, alice) = setup();
        let bob = Address::generate(&env);
        client.set_preferences(&alice, &prefs(&env, 70, 30, "NGNX"));
        assert!(!client.has_preferences(&bob));
    }
}
