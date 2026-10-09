#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoutePreferences {
    pub off_ramp_pct: u32,     // percentage to off-ramp (0-100)
    pub keep_crypto_pct: u32,  // percentage to keep as crypto (0-100)
    pub anchor_asset_code: String, // e.g. "NGNX", "USDC", "GBPT"
    pub anchor_issuer: Address,
}

#[contract]
pub struct RewardRouter;

#[contractimpl]
impl RewardRouter {
    pub fn set_preferences(env: Env, user: Address, prefs: RoutePreferences) {
        user.require_auth();
        // checked_add: two huge values must not wrap around to 100.
        assert!(
            prefs.off_ramp_pct.checked_add(prefs.keep_crypto_pct) == Some(100),
            "allocations must sum to 100"
        );
        assert!(
            prefs.anchor_asset_code.len() >= 1 && prefs.anchor_asset_code.len() <= 12,
            "anchor asset code must be 1-12 characters"
        );
        env.storage().persistent().set(&user, &prefs);
    }

    pub fn get_preferences(env: Env, user: Address) -> RoutePreferences {
        env.storage()
            .persistent()
            .get(&user)
            .expect("no preferences set for this address")
    }

    pub fn has_preferences(env: Env, user: Address) -> bool {
        env.storage().persistent().has(&user)
    }

    /// Lets a developer opt out: AutoFi then falls back to its defaults (or skips).
    pub fn remove_preferences(env: Env, user: Address) {
        user.require_auth();
        env.storage().persistent().remove(&user);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, String};

    #[test]
    fn test_set_and_get_preferences() {
        let env = Env::default();
        let contract_id = env.register(RewardRouter, ());
        let client = RewardRouterClient::new(&env, &contract_id);
        let user = Address::generate(&env);

        env.mock_all_auths();

        let prefs = RoutePreferences {
            off_ramp_pct: 70,
            keep_crypto_pct: 30,
            anchor_asset_code: String::from_str(&env, "NGNX"),
            anchor_issuer: Address::generate(&env),
        };

        client.set_preferences(&user, &prefs);
        let stored = client.get_preferences(&user);
        assert_eq!(stored.off_ramp_pct, 70);
        assert_eq!(stored.keep_crypto_pct, 30);
    }

    #[test]
    #[should_panic(expected = "allocations must sum to 100")]
    fn test_invalid_split_panics() {
        let env = Env::default();
        let contract_id = env.register(RewardRouter, ());
        let client = RewardRouterClient::new(&env, &contract_id);
        let user = Address::generate(&env);

        env.mock_all_auths();

        client.set_preferences(
            &user,
            &RoutePreferences {
                off_ramp_pct: 80,
                keep_crypto_pct: 30, // 80+30 != 100
                anchor_asset_code: String::from_str(&env, "USDC"),
                anchor_issuer: Address::generate(&env),
            },
        );
    }
}
