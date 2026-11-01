use near_sdk::json_types::U128;
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, near_bindgen, AccountId, PanicOnDefault};

/// Persistent policy configuration established once at contract deployment.
#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize, PanicOnDefault)]
pub struct Tapproved {
    owner_id: AccountId,
    agent_id: AccountId,
    device_public_key: Vec<u8>,
    network_id: String,
    soft_limit_yocto: u128,
    hard_limit_yocto: u128,
    daily_limit_yocto: u128,
    allowed_recipients: Vec<AccountId>,
    paused: bool,
    next_payment_id: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PolicyView {
    pub owner_id: AccountId,
    pub agent_id: AccountId,
    pub device_public_key: Vec<u8>,
    pub network_id: String,
    pub soft_limit_yocto: U128,
    pub hard_limit_yocto: U128,
    pub daily_limit_yocto: U128,
    pub allowed_recipients: Vec<AccountId>,
    pub paused: bool,
    pub next_payment_id: u64,
}

#[near_bindgen]
impl Tapproved {
    /// Initialize a fresh policy. The deploying predecessor becomes its owner.
    /// All amounts are exact yoctoNEAR values.
    #[init]
    pub fn new(
        agent_id: AccountId,
        device_public_key: Vec<u8>,
        soft_limit_yocto: U128,
        hard_limit_yocto: U128,
        daily_limit_yocto: U128,
        allowed_recipients: Vec<AccountId>,
        network_id: String,
    ) -> Self {
        let soft = soft_limit_yocto.0;
        let hard = hard_limit_yocto.0;
        let daily = daily_limit_yocto.0;

        if let Err(reason) = validate_policy(
            &device_public_key,
            soft,
            hard,
            daily,
            &allowed_recipients,
            &network_id,
        ) {
            env::panic_str(reason);
        }

        Self {
            owner_id: env::predecessor_account_id(),
            agent_id,
            device_public_key,
            network_id,
            soft_limit_yocto: soft,
            hard_limit_yocto: hard,
            daily_limit_yocto: daily,
            allowed_recipients,
            paused: false,
            next_payment_id: 1,
        }
    }

    /// Read the initialized policy. This method does not expose mutable state.
    pub fn get_policy(&self) -> PolicyView {
        PolicyView {
            owner_id: self.owner_id.clone(),
            agent_id: self.agent_id.clone(),
            device_public_key: self.device_public_key.clone(),
            network_id: self.network_id.clone(),
            soft_limit_yocto: U128(self.soft_limit_yocto),
            hard_limit_yocto: U128(self.hard_limit_yocto),
            daily_limit_yocto: U128(self.daily_limit_yocto),
            allowed_recipients: self.allowed_recipients.clone(),
            paused: self.paused,
            next_payment_id: self.next_payment_id,
        }
    }
}

/// Pure validation is separated from environment access so invariants can be
/// unit-tested without a mocked blockchain context.
fn validate_policy(
    device_public_key: &[u8],
    soft_limit_yocto: u128,
    hard_limit_yocto: u128,
    daily_limit_yocto: u128,
    allowed_recipients: &[AccountId],
    network_id: &str,
) -> Result<(), &'static str> {
    if device_public_key.len() != 32 {
        return Err("device_public_key must contain exactly 32 Ed25519 public-key bytes");
    }
    if soft_limit_yocto == 0 {
        return Err("soft_limit_yocto must be greater than zero");
    }
    if hard_limit_yocto == 0 || soft_limit_yocto > hard_limit_yocto {
        return Err("limits must satisfy 0 < soft_limit_yocto <= hard_limit_yocto");
    }
    if daily_limit_yocto < hard_limit_yocto {
        return Err("daily_limit_yocto must be at least hard_limit_yocto");
    }
    if allowed_recipients.is_empty() {
        return Err("allowed_recipients must contain at least one account");
    }
    if network_id != "testnet" {
        return Err("network_id must be testnet; mainnet is not supported");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(value: &str) -> AccountId {
        value.parse().expect("valid test account")
    }

    fn valid_policy() -> Result<(), &'static str> {
        validate_policy(
            &[7_u8; 32],
            10,
            100,
            1_000,
            &[account("merchant.testnet")],
            "testnet",
        )
    }

    #[test]
    fn accepts_valid_policy() {
        assert!(valid_policy().is_ok());
    }

    #[test]
    fn rejects_public_key_with_wrong_length() {
        let result = validate_policy(
            &[7_u8; 31],
            10,
            100,
            1_000,
            &[account("merchant.testnet")],
            "testnet",
        );
        assert_eq!(
            result,
            Err("device_public_key must contain exactly 32 Ed25519 public-key bytes")
        );
    }

    #[test]
    fn rejects_zero_soft_limit() {
        let result = validate_policy(
            &[7_u8; 32],
            0,
            100,
            1_000,
            &[account("merchant.testnet")],
            "testnet",
        );
        assert_eq!(result, Err("soft_limit_yocto must be greater than zero"));
    }

    #[test]
    fn rejects_soft_limit_above_hard_limit() {
        let result = validate_policy(
            &[7_u8; 32],
            101,
            100,
            1_000,
            &[account("merchant.testnet")],
            "testnet",
        );
        assert_eq!(
            result,
            Err("limits must satisfy 0 < soft_limit_yocto <= hard_limit_yocto")
        );
    }

    #[test]
    fn rejects_daily_limit_below_hard_limit() {
        let result = validate_policy(
            &[7_u8; 32],
            10,
            100,
            99,
            &[account("merchant.testnet")],
            "testnet",
        );
        assert_eq!(
            result,
            Err("daily_limit_yocto must be at least hard_limit_yocto")
        );
    }

    #[test]
    fn rejects_empty_recipient_allowlist() {
        let result = validate_policy(&[7_u8; 32], 10, 100, 1_000, &[], "testnet");
        assert_eq!(
            result,
            Err("allowed_recipients must contain at least one account")
        );
    }

    #[test]
    fn rejects_non_testnet_network() {
        let result = validate_policy(
            &[7_u8; 32],
            10,
            100,
            1_000,
            &[account("merchant.testnet")],
            "mainnet",
        );
        assert_eq!(
            result,
            Err("network_id must be testnet; mainnet is not supported")
        );
    }
}
