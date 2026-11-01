use near_sdk::json_types::U128;
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, near_bindgen, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseResult};

const REQUEST_TTL_NS: u64 = 300_000_000_000;
const NANOS_PER_DAY: u64 = 86_400_000_000_000;

/// Persistent policy and payment authorization state.
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
    payments: Vec<Payment>,
    active_payment_id: Option<u64>,
    daily_usage: Vec<DailyUsage>,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
pub enum PaymentStatus {
    Pending,
    Approved,
    Processing,
    Paid,
    Failed,
    Expired,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct Payment {
    pub id: u64,
    pub agent_id: AccountId,
    pub recipient_id: AccountId,
    pub amount_yocto: u128,
    pub nonce: u64,
    pub created_at_ns: u64,
    pub expires_at_ns: u64,
    pub status: PaymentStatus,
    pub hardware_approved: bool,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct DailyUsage {
    utc_day: u64,
    reserved_yocto: u128,
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

#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PaymentView {
    pub id: u64,
    pub agent_id: AccountId,
    pub recipient_id: AccountId,
    pub amount_yocto: U128,
    pub nonce: u64,
    pub created_at_ns: u64,
    pub expires_at_ns: u64,
    pub status: PaymentStatus,
    pub hardware_approved: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct DailyUsageView {
    pub utc_day: u64,
    pub reserved_yocto: U128,
    pub daily_limit_yocto: U128,
}

#[near_bindgen]
impl Tapproved {
    /// One-time testnet policy initialization. The predecessor becomes owner.
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
        let (soft, hard, daily) = (soft_limit_yocto.0, hard_limit_yocto.0, daily_limit_yocto.0);
        if let Err(reason) = validate_policy(&device_public_key, soft, hard, daily, &allowed_recipients, &network_id) {
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
            payments: Vec::new(),
            active_payment_id: None,
            daily_usage: Vec::new(),
        }
    }

    /// One-time recovery for accounts whose existing STATE was written by an
    /// incompatible contract. Bypasses old-state deserialization but leaves
    /// unrelated storage keys untouched.
    #[init(ignore_state)]
    pub fn migrate_from_incompatible_state(
        agent_id: AccountId,
        device_public_key: Vec<u8>,
        soft_limit_yocto: U128,
        hard_limit_yocto: U128,
        daily_limit_yocto: U128,
        allowed_recipients: Vec<AccountId>,
        network_id: String,
    ) -> Self {
        if env::predecessor_account_id() != env::current_account_id() {
            env::panic_str("migration must be authorized by the contract account itself");
        }
        const MIGRATION_MARKER: &[u8] = b"tapproved:migration:incompatible-state:v1";
        if env::storage_read(MIGRATION_MARKER).is_some() {
            env::panic_str("incompatible-state migration has already been used");
        }
        let (soft, hard, daily) = (soft_limit_yocto.0, hard_limit_yocto.0, daily_limit_yocto.0);
        if let Err(reason) = validate_policy(&device_public_key, soft, hard, daily, &allowed_recipients, &network_id) {
            env::panic_str(reason);
        }
        env::storage_write(MIGRATION_MARKER, b"completed");
        Self {
            owner_id: env::current_account_id(),
            agent_id,
            device_public_key,
            network_id,
            soft_limit_yocto: soft,
            hard_limit_yocto: hard,
            daily_limit_yocto: daily,
            allowed_recipients,
            paused: false,
            next_payment_id: 1,
            payments: Vec::new(),
            active_payment_id: None,
            daily_usage: Vec::new(),
        }
    }

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

    /// Creates an authorization request. Small payments are auto-approved;
    /// larger payments remain Pending for the hardware-signature stage.
    /// No NEAR transfer occurs in this stage.
    pub fn request_spend(&mut self, recipient_id: AccountId, amount_yocto: U128) -> PaymentView {
        if env::predecessor_account_id() != self.agent_id {
            env::panic_str("only the registered agent may request a spend");
        }
        if self.paused {
            env::panic_str("spending is paused");
        }
        if self.active_payment_id.is_some() {
            env::panic_str("another payment is still active");
        }
        let amount = amount_yocto.0;
        if amount == 0 {
            env::panic_str("amount must be greater than zero");
        }
        if amount > self.hard_limit_yocto {
            env::panic_str("amount exceeds hard per-payment limit");
        }
        if !self.allowed_recipients.contains(&recipient_id) {
            env::panic_str("recipient is not allowlisted");
        }

        let now = env::block_timestamp();
        let expiry = now.checked_add(REQUEST_TTL_NS).unwrap_or_else(|| env::panic_str("expiry overflow"));
        let day = now / NANOS_PER_DAY;
        let current = self.daily_usage.iter().find(|entry| entry.utc_day == day)
            .map(|entry| entry.reserved_yocto).unwrap_or(0);
        let next_total = current.checked_add(amount).unwrap_or_else(|| env::panic_str("daily usage overflow"));
        if next_total > self.daily_limit_yocto {
            env::panic_str("request exceeds remaining UTC daily limit");
        }

        if let Some(entry) = self.daily_usage.iter_mut().find(|entry| entry.utc_day == day) {
            entry.reserved_yocto = next_total;
        } else {
            self.daily_usage.push(DailyUsage { utc_day: day, reserved_yocto: amount });
        }

        let id = self.next_payment_id;
        self.next_payment_id = id.checked_add(1).unwrap_or_else(|| env::panic_str("payment id overflow"));
        let status = if amount <= self.soft_limit_yocto { PaymentStatus::Approved } else { PaymentStatus::Pending };
        let payment = Payment {
            id,
            agent_id: self.agent_id.clone(),
            recipient_id,
            amount_yocto: amount,
            nonce: id,
            created_at_ns: now,
            expires_at_ns: expiry,
            status,
            hardware_approved: false,
        };
        let view = payment_to_view(&payment);
        self.payments.push(payment);
        self.active_payment_id = Some(id);
        view
    }

    /// Permissionless hardware approval. Signed bytes are reconstructed from stored state.
    pub fn approve_spend(&mut self, payment_id: u64, signature: Vec<u8>) -> Promise {
        let index = self.active_index(payment_id);
        let payment = self.payments[index].clone();
        if payment.status != PaymentStatus::Pending { env::panic_str("payment is not pending hardware approval"); }
        if env::block_timestamp() > payment.expires_at_ns { env::panic_str("payment approval has expired"); }
        let sig: [u8; 64] = signature.as_slice().try_into().unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"));
        let key: [u8; 32] = self.device_public_key.as_slice().try_into().unwrap_or_else(|_| env::panic_str("invalid stored device key"));
        let message = canonical_approval_message(&payment, &env::current_account_id(), &self.network_id);
        if !env::ed25519_verify(&sig, &message, &key) { env::panic_str("invalid hardware approval signature"); }
        self.payments[index].hardware_approved = true;
        self.payments[index].status = PaymentStatus::Processing;
        self.transfer_promise(payment)
    }

    /// Execute an auto-approved payment below the soft limit.
    pub fn execute_approved_spend(&mut self, payment_id: u64) -> Promise {
        let index = self.active_index(payment_id);
        let payment = self.payments[index].clone();
        if payment.status != PaymentStatus::Approved || payment.amount_yocto > self.soft_limit_yocto {
            env::panic_str("payment is not eligible for automatic execution");
        }
        if env::block_timestamp() > payment.expires_at_ns { env::panic_str("payment has expired"); }
        self.payments[index].status = PaymentStatus::Processing;
        self.transfer_promise(payment)
    }

    #[private]
    pub fn on_transfer_result(&mut self, payment_id: u64) -> PaymentView {
        let index = self.active_index(payment_id);
        if self.payments[index].status != PaymentStatus::Processing { env::panic_str("payment is not processing"); }
        let payment = self.payments[index].clone();
        match env::promise_result(0) {
            PromiseResult::Successful(_) => self.payments[index].status = PaymentStatus::Paid,
            PromiseResult::Failed => {
                self.release_reservation(&payment);
                self.payments[index].status = PaymentStatus::Failed;
            }
        }
        self.active_payment_id = None;
        payment_to_view(&self.payments[index])
    }

    fn active_index(&self, payment_id: u64) -> usize {
        if self.active_payment_id != Some(payment_id) { env::panic_str("payment is not active"); }
        self.payments.iter().position(|p| p.id == payment_id).unwrap_or_else(|| env::panic_str("payment not found"))
    }

    fn release_reservation(&mut self, payment: &Payment) {
        let day = payment.created_at_ns / NANOS_PER_DAY;
        let usage = self.daily_usage.iter_mut().find(|entry| entry.utc_day == day)
            .unwrap_or_else(|| env::panic_str("daily reservation record missing"));
        usage.reserved_yocto = usage.reserved_yocto.checked_sub(payment.amount_yocto)
            .unwrap_or_else(|| env::panic_str("daily reservation accounting underflow"));
    }

    fn transfer_promise(&self, payment: Payment) -> Promise {
        let args = near_sdk::serde_json::json!({ "payment_id": payment.id }).to_string().into_bytes();
        Promise::new(payment.recipient_id)
            .transfer(NearToken::from_yoctonear(payment.amount_yocto))
            .then(Promise::new(env::current_account_id()).function_call(
                "on_transfer_result".to_string(), args, NearToken::from_yoctonear(0), Gas::from_tgas(10)
            ))
    }

    /// Permissionless expiry. Expired reservations are released from their
    /// original UTC-day bucket, not from the caller's current day.
    pub fn expire_payment(&mut self, payment_id: u64) {
        let now = env::block_timestamp();
        let index = self.payments.iter().position(|p| p.id == payment_id)
            .unwrap_or_else(|| env::panic_str("payment not found"));
        let payment = self.payments[index].clone();
        if self.active_payment_id != Some(payment_id) {
            env::panic_str("payment is not active");
        }
        if now <= payment.expires_at_ns {
            env::panic_str("payment has not expired");
        }
        if payment.status != PaymentStatus::Pending && payment.status != PaymentStatus::Approved {
            env::panic_str("payment is not expirable");
        }
        let day = payment.created_at_ns / NANOS_PER_DAY;
        if let Some(usage) = self.daily_usage.iter_mut().find(|entry| entry.utc_day == day) {
            usage.reserved_yocto = usage.reserved_yocto.checked_sub(payment.amount_yocto)
                .unwrap_or_else(|| env::panic_str("daily reservation accounting underflow"));
        } else {
            env::panic_str("daily reservation record missing");
        }
        self.payments[index].status = PaymentStatus::Expired;
        self.active_payment_id = None;
    }

    pub fn get_payment(&self, payment_id: u64) -> Option<PaymentView> {
        self.payments.iter().find(|p| p.id == payment_id).map(payment_to_view)
    }

    pub fn get_active_payment(&self) -> Option<PaymentView> {
        self.active_payment_id.and_then(|id| self.get_payment(id))
    }

    pub fn get_daily_usage(&self, utc_day: u64) -> DailyUsageView {
        let reserved = self.daily_usage.iter().find(|entry| entry.utc_day == utc_day)
            .map(|entry| entry.reserved_yocto).unwrap_or(0);
        DailyUsageView { utc_day, reserved_yocto: U128(reserved), daily_limit_yocto: U128(self.daily_limit_yocto) }
    }
}

/// Canonical Tapproved v1 approval payload. Integers use little-endian encoding.
fn canonical_approval_message(payment: &Payment, contract_id: &AccountId, network_id: &str) -> Vec<u8> {
    let contract = contract_id.as_bytes();
    let network = network_id.as_bytes();
    let recipient = payment.recipient_id.as_bytes();
    let mut out = Vec::with_capacity(128 + contract.len() + network.len() + recipient.len());
    out.extend_from_slice(b"TAPPROVED\0\x01");
    out.extend_from_slice(&(contract.len() as u32).to_le_bytes());
    out.extend_from_slice(contract);
    out.extend_from_slice(&(network.len() as u32).to_le_bytes());
    out.extend_from_slice(network);
    out.extend_from_slice(&payment.id.to_le_bytes());
    out.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
    out.extend_from_slice(recipient);
    out.extend_from_slice(&payment.amount_yocto.to_le_bytes());
    out.extend_from_slice(&payment.nonce.to_le_bytes());
    out.extend_from_slice(&payment.expires_at_ns.to_le_bytes());
    out
}

fn payment_to_view(payment: &Payment) -> PaymentView {
    PaymentView {
        id: payment.id,
        agent_id: payment.agent_id.clone(),
        recipient_id: payment.recipient_id.clone(),
        amount_yocto: U128(payment.amount_yocto),
        nonce: payment.nonce,
        created_at_ns: payment.created_at_ns,
        expires_at_ns: payment.expires_at_ns,
        status: payment.status,
        hardware_approved: payment.hardware_approved,
    }
}

fn validate_policy(
    device_public_key: &[u8], soft_limit_yocto: u128, hard_limit_yocto: u128,
    daily_limit_yocto: u128, allowed_recipients: &[AccountId], network_id: &str,
) -> Result<(), &'static str> {
    if device_public_key.len() != 32 { return Err("device_public_key must contain exactly 32 Ed25519 public-key bytes"); }
    if soft_limit_yocto == 0 { return Err("soft_limit_yocto must be greater than zero"); }
    if hard_limit_yocto == 0 || soft_limit_yocto > hard_limit_yocto { return Err("limits must satisfy 0 < soft_limit_yocto <= hard_limit_yocto"); }
    if daily_limit_yocto < hard_limit_yocto { return Err("daily_limit_yocto must be at least hard_limit_yocto"); }
    if allowed_recipients.is_empty() { return Err("allowed_recipients must contain at least one account"); }
    if network_id != "testnet" { return Err("network_id must be testnet; mainnet is not supported"); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn account(value: &str) -> AccountId { value.parse().expect("valid test account") }

    #[test]
    fn deployed_presence_state_fixture_is_not_tapproved_state() {
        // Decoded from the STATE value observed on manextech.testnet.
        let legacy_state = [
            0x08, 0x00, 0x00, 0x00, b'p', b'r', b'e', b's', b'e', b'n', b'c', b'e',
            0x0b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];
        assert!(Tapproved::try_from_slice(&legacy_state).is_err());
    }

    #[test]
    fn migration_initializes_policy_and_preserves_unrelated_storage() {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;
        let context = VMContextBuilder::new()
            .current_account_id(account("manextech.testnet"))
            .predecessor_account_id(account("manextech.testnet"))
            .build();
        testing_env!(context);
        env::storage_write(b"presence_name:fixture", b"legacy-value");
        let state = Tapproved::migrate_from_incompatible_state(
            account("manex-agent.testnet"), vec![7; 32], U128(10), U128(100),
            U128(1_000), vec![account("merchant.testnet")], "testnet".to_string(),
        );
        assert_eq!(state.owner_id, account("manextech.testnet"));
        assert_eq!(state.agent_id, account("manex-agent.testnet"));
        assert_eq!(state.next_payment_id, 1);
        assert_eq!(state.active_payment_id, None);
        assert_eq!(env::storage_read(b"presence_name:fixture"), Some(b"legacy-value".to_vec()));
        assert_eq!(env::storage_read(b"tapproved:migration:incompatible-state:v1"), Some(b"completed".to_vec()));
    }

    #[test]
    fn accepts_valid_policy() {
        assert!(validate_policy(&[7; 32], 10, 100, 1_000, &[account("merchant.testnet")], "testnet").is_ok());
    }
    #[test]
    fn rejects_wrong_key_length() {
        assert!(validate_policy(&[7; 31], 10, 100, 1_000, &[account("merchant.testnet")], "testnet").is_err());
    }
    #[test]
    fn rejects_zero_soft_limit() {
        assert!(validate_policy(&[7; 32], 0, 100, 1_000, &[account("merchant.testnet")], "testnet").is_err());
    }
    #[test]
    fn rejects_soft_above_hard_limit() {
        assert!(validate_policy(&[7; 32], 101, 100, 1_000, &[account("merchant.testnet")], "testnet").is_err());
    }
    #[test]
    fn rejects_daily_below_hard_limit() {
        assert!(validate_policy(&[7; 32], 10, 100, 99, &[account("merchant.testnet")], "testnet").is_err());
    }
    #[test]
    fn rejects_empty_allowlist() {
        assert!(validate_policy(&[7; 32], 10, 100, 1_000, &[], "testnet").is_err());
    }
    #[test]
    fn rejects_mainnet() {
        assert!(validate_policy(&[7; 32], 10, 100, 1_000, &[account("merchant.testnet")], "mainnet").is_err());
    }
}
