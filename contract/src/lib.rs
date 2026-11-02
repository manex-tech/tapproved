use near_sdk::json_types::{U128, U64};
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

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
pub enum PaymentStatus {
    Pending,
    Approved,
    Processing,
    Paid,
    Failed,
    Expired,
    Cancelled,
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
    pub next_payment_id: U64,
}

#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PaymentView {
    pub id: U64,
    pub agent_id: AccountId,
    pub recipient_id: AccountId,
    pub amount_yocto: U128,
    pub nonce: U64,
    pub created_at_ns: U64,
    pub expires_at_ns: U64,
    pub status: PaymentStatus,
    pub hardware_approved: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct DailyUsageView {
    pub utc_day: U64,
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

    /// Pause all new spending requests. Only the policy owner may change this state.
    pub fn pause(&mut self) { self.assert_owner(); self.paused = true; }

    /// Resume spending requests. Only the policy owner may change this state.
    pub fn unpause(&mut self) { self.assert_owner(); self.paused = false; }

    /// Cancel an active Pending or Approved payment and release its reservation.
    pub fn cancel_payment(&mut self, payment_id: u64) {
        self.assert_owner();
        let index = self.active_index(payment_id);
        let payment = self.payments[index].clone();
        if payment.status != PaymentStatus::Pending && payment.status != PaymentStatus::Approved {
            env::panic_str("only pending or approved payments can be cancelled");
        }
        self.release_reservation(&payment);
        self.payments[index].status = PaymentStatus::Cancelled;
        self.active_payment_id = None;
    }

    /// Replace the registered ESP32 Ed25519 public key.
    pub fn rotate_device_key(&mut self, device_public_key: Vec<u8>) {
        self.assert_owner();
        if device_public_key.len() != 32 {
            env::panic_str("device_public_key must contain exactly 32 Ed25519 public-key bytes");
        }
        self.device_public_key = device_public_key;
    }

    /// Replace the account authorized to request spending.
    pub fn set_agent(&mut self, agent_id: AccountId) {
        self.assert_owner();
        self.agent_id = agent_id;
    }

    /// Add a recipient to the spending allowlist.
    pub fn add_allowed_recipient(&mut self, recipient_id: AccountId) {
        self.assert_owner();
        if self.allowed_recipients.contains(&recipient_id) { env::panic_str("recipient is already allowlisted"); }
        self.allowed_recipients.push(recipient_id);
    }

    /// Remove a recipient from the spending allowlist.
    pub fn remove_allowed_recipient(&mut self, recipient_id: AccountId) {
        self.assert_owner();
        if !self.allowed_recipients.contains(&recipient_id) { env::panic_str("recipient is not allowlisted"); }
        if self.allowed_recipients.len() == 1 { env::panic_str("allowlist must contain at least one recipient"); }
        self.allowed_recipients.retain(|id| id != &recipient_id);
    }

    fn assert_owner(&self) {
        if env::predecessor_account_id() != self.owner_id { env::panic_str("only the owner may call this method"); }
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
            next_payment_id: U64(self.next_payment_id),
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
        DailyUsageView { utc_day: U64(utc_day), reserved_yocto: U128(reserved), daily_limit_yocto: U128(self.daily_limit_yocto) }
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
        id: U64(payment.id),
        agent_id: payment.agent_id.clone(),
        recipient_id: payment.recipient_id.clone(),
        amount_yocto: U128(payment.amount_yocto),
        nonce: U64(payment.nonce),
        created_at_ns: U64(payment.created_at_ns),
        expires_at_ns: U64(payment.expires_at_ns),
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

    fn admin_contract(predecessor: &str) -> Tapproved {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;
        testing_env!(VMContextBuilder::new().current_account_id(account("tapproved.testnet"))
            .predecessor_account_id(account(predecessor)).build());
        Tapproved::new(account("agent.testnet"), vec![7; 32], U128(10), U128(100), U128(1_000),
            vec![account("merchant.testnet")], "testnet".to_string())
    }

    fn set_predecessor(predecessor: &str) {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;
        testing_env!(VMContextBuilder::new().current_account_id(account("tapproved.testnet"))
            .predecessor_account_id(account(predecessor)).build());
    }

    #[test]
    fn owner_can_pause_and_unpause() {
        let mut c = admin_contract("owner.testnet");
        c.pause(); assert!(c.paused);
        c.unpause(); assert!(!c.paused);
    }
    #[test]
    #[should_panic(expected = "only the owner may call this method")]
    fn non_owner_cannot_pause() { let mut c = admin_contract("owner.testnet"); set_predecessor("attacker.testnet"); c.pause(); }
    #[test]
    #[should_panic(expected = "only the owner may call this method")]
    fn non_owner_cannot_unpause() { let mut c = admin_contract("owner.testnet"); set_predecessor("attacker.testnet"); c.unpause(); }

    #[test]
    fn owner_can_cancel_pending_payment_and_release_reservation() {
        let mut c = admin_contract("owner.testnet");
        set_predecessor("agent.testnet");
        let p = c.request_spend(account("merchant.testnet"), U128(50));
        assert_eq!(c.get_daily_usage(0).reserved_yocto.0, 50);
        set_predecessor("owner.testnet"); c.cancel_payment(p.id.0);
        assert_eq!(c.active_payment_id, None);
        assert_eq!(c.get_payment(p.id.0).unwrap().status, PaymentStatus::Cancelled);
        assert_eq!(c.get_daily_usage(0).reserved_yocto.0, 0);
    }
    #[test]
    #[should_panic(expected = "only the owner may call this method")]
    fn non_owner_cannot_cancel_payment() {
        let mut c = admin_contract("owner.testnet"); set_predecessor("agent.testnet");
        let p = c.request_spend(account("merchant.testnet"), U128(50));
        set_predecessor("attacker.testnet"); c.cancel_payment(p.id.0);
    }

    #[test]
    fn owner_can_rotate_device_key() { let mut c = admin_contract("owner.testnet"); c.rotate_device_key(vec![9; 32]); assert_eq!(c.device_public_key, vec![9; 32]); }
    #[test]
    #[should_panic(expected = "only the owner may call this method")]
    fn non_owner_cannot_rotate_device_key() { let mut c = admin_contract("owner.testnet"); set_predecessor("attacker.testnet"); c.rotate_device_key(vec![9; 32]); }
    #[test]
    #[should_panic(expected = "device_public_key must contain exactly 32")]
    fn owner_cannot_rotate_to_invalid_key_length() { let mut c = admin_contract("owner.testnet"); c.rotate_device_key(vec![9; 31]); }

    #[test]
    fn owner_can_set_agent() { let mut c = admin_contract("owner.testnet"); c.set_agent(account("new-agent.testnet")); assert_eq!(c.agent_id, account("new-agent.testnet")); }
    #[test]
    #[should_panic(expected = "only the owner may call this method")]
    fn non_owner_cannot_set_agent() { let mut c = admin_contract("owner.testnet"); set_predecessor("attacker.testnet"); c.set_agent(account("new-agent.testnet")); }

    #[test]
    fn owner_can_add_and_remove_allowed_recipient() {
        let mut c = admin_contract("owner.testnet"); c.add_allowed_recipient(account("second-merchant.testnet"));
        assert!(c.allowed_recipients.contains(&account("second-merchant.testnet")));
        c.remove_allowed_recipient(account("second-merchant.testnet"));
        assert!(!c.allowed_recipients.contains(&account("second-merchant.testnet")));
    }
    #[test]
    #[should_panic(expected = "only the owner may call this method")]
    fn non_owner_cannot_add_allowed_recipient() { let mut c = admin_contract("owner.testnet"); set_predecessor("attacker.testnet"); c.add_allowed_recipient(account("second-merchant.testnet")); }
    #[test]
    #[should_panic(expected = "only the owner may call this method")]
    fn non_owner_cannot_remove_allowed_recipient() {
        let mut c = admin_contract("owner.testnet"); c.add_allowed_recipient(account("second-merchant.testnet"));
        set_predecessor("attacker.testnet"); c.remove_allowed_recipient(account("second-merchant.testnet"));
    }
    #[test]
    #[should_panic(expected = "allowlist must contain at least one recipient")]
    fn owner_cannot_remove_last_allowed_recipient() { let mut c = admin_contract("owner.testnet"); c.remove_allowed_recipient(account("merchant.testnet")); }


    const VECTOR_PUBLIC_KEY: &str = "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8";
    const VECTOR_SIGNATURE: &str = "b95fe907aecd36dd17ba4b98b3966d71b8ea87dbd2ab5d4c0a484f1e104b449ff2a10419476c41da42419461c8140509f99c6c9de4839348e68cd49bd3199702";
    const ESP32_PUBLIC_KEY: &str = "A5529E95FF0180CA709661D902ECC000F9688A069AA635E8D98F58CBA3195BAD";
    const ESP32_SIGNATURE: &str = "01ADBF4072D54089CE380EC74E495413EC14561B4D761A6B8115BC2E191AFC08F2CA97E932C557614BB9ABA924484152C08A16A584B5B702A36769F54B8EB00B";
    const FIXTURE_AMOUNT: u128 = 123456789012345678901234567890;
    const FIXTURE_EXPIRY: u64 = 1_793_520_000_000_000_000;
    const FIXTURE_NOW: u64 = 1_793_519_700_000_000_000;

    fn decode_hex(value: &str) -> Vec<u8> {
        value.as_bytes().chunks_exact(2).map(|pair| {
            let digit = |b: u8| match b {
                b'0'..=b'9' => b - b'0',
                b'a'..=b'f' => b - b'a' + 10,
                b'A'..=b'F' => b - b'A' + 10,
                _ => panic!("invalid hex"),
            };
            (digit(pair[0]) << 4) | digit(pair[1])
        }).collect()
    }

    fn context_at(predecessor: &str, current: &str, timestamp: u64) {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;
        testing_env!(VMContextBuilder::new()
            .current_account_id(account(current))
            .predecessor_account_id(account(predecessor))
            .block_timestamp(timestamp)
            .build());
    }

    fn fixture_contract(public_key: &str) -> Tapproved {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("tapproved.testnet"))
            .predecessor_account_id(account("owner.testnet"))
            .block_timestamp(FIXTURE_NOW)
            .account_balance(near_sdk::NearToken::from_yoctonear(FIXTURE_AMOUNT * 2))
            .build());
        let mut c = Tapproved::new(
            account("agent.testnet"), decode_hex(public_key), U128(10), U128(FIXTURE_AMOUNT),
            U128(FIXTURE_AMOUNT * 2), vec![account("merchant.testnet")], "testnet".to_string()
        );
        let payment = Payment {
            id: 42, agent_id: account("agent.testnet"), recipient_id: account("merchant.testnet"),
            amount_yocto: FIXTURE_AMOUNT, nonce: 42, created_at_ns: FIXTURE_NOW,
            expires_at_ns: FIXTURE_EXPIRY, status: PaymentStatus::Pending, hardware_approved: false,
        };
        c.next_payment_id = 43;
        c.daily_usage.push(DailyUsage { utc_day: FIXTURE_NOW / NANOS_PER_DAY, reserved_yocto: FIXTURE_AMOUNT });
        c.payments.push(payment);
        c.active_payment_id = Some(42);
        c
    }

    fn request_contract(timestamp: u64) -> Tapproved {
        context_at("owner.testnet", "tapproved.testnet", timestamp);
        Tapproved::new(account("agent.testnet"), vec![7; 32], U128(10), U128(100), U128(150),
            vec![account("merchant.testnet")], "testnet".to_string())
    }

    #[test]
    fn request_within_soft_limit_is_approved() {
        let mut c = request_contract(FIXTURE_NOW);
        context_at("agent.testnet", "tapproved.testnet", FIXTURE_NOW);
        let p = c.request_spend(account("merchant.testnet"), U128(10));
        assert_eq!(p.status, PaymentStatus::Approved);
        assert_eq!(c.active_payment_id, Some(p.id.0));
    }

    #[test]
    fn request_above_soft_limit_is_pending() {
        let mut c = request_contract(FIXTURE_NOW);
        context_at("agent.testnet", "tapproved.testnet", FIXTURE_NOW);
        let p = c.request_spend(account("merchant.testnet"), U128(11));
        assert_eq!(p.status, PaymentStatus::Pending);
    }

    #[test]
    #[should_panic(expected = "only the registered agent")]
    fn non_agent_cannot_request_spend() {
        let mut c = request_contract(FIXTURE_NOW);
        context_at("attacker.testnet", "tapproved.testnet", FIXTURE_NOW);
        c.request_spend(account("merchant.testnet"), U128(5));
    }

    #[test]
    #[should_panic(expected = "spending is paused")]
    fn paused_contract_rejects_request() {
        let mut c = request_contract(FIXTURE_NOW);
        c.paused = true;
        context_at("agent.testnet", "tapproved.testnet", FIXTURE_NOW);
        c.request_spend(account("merchant.testnet"), U128(5));
    }

    #[test]
    #[should_panic(expected = "another payment is still active")]
    fn second_request_while_active_is_rejected() {
        let mut c = request_contract(FIXTURE_NOW);
        context_at("agent.testnet", "tapproved.testnet", FIXTURE_NOW);
        c.request_spend(account("merchant.testnet"), U128(5));
        c.request_spend(account("merchant.testnet"), U128(5));
    }

    #[test]
    #[should_panic(expected = "recipient is not allowlisted")]
    fn non_allowlisted_recipient_is_rejected() {
        let mut c = request_contract(FIXTURE_NOW);
        context_at("agent.testnet", "tapproved.testnet", FIXTURE_NOW);
        c.request_spend(account("other-merchant.testnet"), U128(5));
    }

    #[test]
    #[should_panic(expected = "amount exceeds hard per-payment limit")]
    fn hard_per_payment_cap_is_enforced() {
        let mut c = request_contract(FIXTURE_NOW);
        context_at("agent.testnet", "tapproved.testnet", FIXTURE_NOW);
        c.request_spend(account("merchant.testnet"), U128(101));
    }

    #[test]
    #[should_panic(expected = "request exceeds remaining UTC daily limit")]
    fn daily_cap_is_enforced_across_reservations() {
        let mut c = request_contract(FIXTURE_NOW);
        context_at("agent.testnet", "tapproved.testnet", FIXTURE_NOW);
        c.request_spend(account("merchant.testnet"), U128(90));
        c.active_payment_id = None;
        c.request_spend(account("merchant.testnet"), U128(61));
    }

    #[test]
    fn protocol_v1_vector_signature_is_accepted() {
        let mut c = fixture_contract(VECTOR_PUBLIC_KEY);
        let _promise = c.approve_spend(42, decode_hex(VECTOR_SIGNATURE));
        assert_eq!(c.payments[0].status, PaymentStatus::Processing);
        assert!(c.payments[0].hardware_approved);
    }

    #[test]
    fn real_esp32_signature_is_accepted() {
        let mut c = fixture_contract(ESP32_PUBLIC_KEY);
        let _promise = c.approve_spend(42, decode_hex(ESP32_SIGNATURE));
        assert_eq!(c.payments[0].status, PaymentStatus::Processing);
        assert!(c.payments[0].hardware_approved);
    }

    #[test]
    #[should_panic(expected = "invalid hardware approval signature")]
    fn tampered_amount_invalidates_signature() {
        let mut c = fixture_contract(ESP32_PUBLIC_KEY);
        c.payments[0].amount_yocto += 1;
        let _promise = c.approve_spend(42, decode_hex(ESP32_SIGNATURE));
    }

    #[test]
    #[should_panic(expected = "invalid hardware approval signature")]
    fn wrong_contract_id_invalidates_signature() {
        let mut c = fixture_contract(ESP32_PUBLIC_KEY);
        context_at("relayer.testnet", "different-contract.testnet", FIXTURE_NOW);
        let _promise = c.approve_spend(42, decode_hex(ESP32_SIGNATURE));
    }

    #[test]
    #[should_panic(expected = "invalid hardware approval signature")]
    fn wrong_device_key_rejects_signature() {
        let mut c = fixture_contract(ESP32_PUBLIC_KEY);
        c.device_public_key = decode_hex(VECTOR_PUBLIC_KEY);
        let _promise = c.approve_spend(42, decode_hex(ESP32_SIGNATURE));
    }

    #[test]
    #[should_panic(expected = "payment approval has expired")]
    fn expired_hardware_approval_is_rejected() {
        let mut c = fixture_contract(ESP32_PUBLIC_KEY);
        context_at("relayer.testnet", "tapproved.testnet", FIXTURE_EXPIRY + 1);
        let _promise = c.approve_spend(42, decode_hex(ESP32_SIGNATURE));
    }

    #[test]
    #[should_panic(expected = "payment is not active")]
    fn replay_after_paid_payment_is_rejected() {
        let mut c = fixture_contract(ESP32_PUBLIC_KEY);
        c.payments[0].status = PaymentStatus::Paid;
        c.active_payment_id = None;
        let _promise = c.approve_spend(42, decode_hex(ESP32_SIGNATURE));
    }

    #[test]
    #[should_panic(expected = "payment is not active")]
    fn replay_after_failed_payment_is_rejected() {
        let mut c = fixture_contract(ESP32_PUBLIC_KEY);
        c.payments[0].status = PaymentStatus::Failed;
        c.active_payment_id = None;
        let _promise = c.approve_spend(42, decode_hex(ESP32_SIGNATURE));
    }


    #[test]
    fn transfer_callback_success_marks_payment_paid() {
        use near_sdk::test_utils::testing_env_with_promise_results;
        use near_sdk::test_utils::VMContextBuilder;
        let mut c = fixture_contract(ESP32_PUBLIC_KEY);
        c.payments[0].status = PaymentStatus::Processing;
        testing_env_with_promise_results(
            VMContextBuilder::new().current_account_id(account("tapproved.testnet"))
                .predecessor_account_id(account("tapproved.testnet")).block_timestamp(FIXTURE_NOW).build(),
            PromiseResult::Successful(vec![]),
        );
        let result = c.on_transfer_result(42);
        assert_eq!(result.status, PaymentStatus::Paid);
        assert_eq!(c.active_payment_id, None);
        assert_eq!(c.daily_usage[0].reserved_yocto, FIXTURE_AMOUNT);
    }

    #[test]
    fn transfer_callback_failure_marks_failed_and_releases_reservation() {
        use near_sdk::test_utils::testing_env_with_promise_results;
        use near_sdk::test_utils::VMContextBuilder;
        let mut c = fixture_contract(ESP32_PUBLIC_KEY);
        c.payments[0].status = PaymentStatus::Processing;
        testing_env_with_promise_results(
            VMContextBuilder::new().current_account_id(account("tapproved.testnet"))
                .predecessor_account_id(account("tapproved.testnet")).block_timestamp(FIXTURE_NOW).build(),
            PromiseResult::Failed,
        );
        let result = c.on_transfer_result(42);
        assert_eq!(result.status, PaymentStatus::Failed);
        assert_eq!(c.active_payment_id, None);
        assert_eq!(c.daily_usage[0].reserved_yocto, 0);
    }

    #[test]
    fn expiry_releases_reservation_and_clears_active_payment() {
        let mut c = fixture_contract(ESP32_PUBLIC_KEY);
        context_at("caller.testnet", "tapproved.testnet", FIXTURE_EXPIRY + 1);
        c.expire_payment(42);
        assert_eq!(c.payments[0].status, PaymentStatus::Expired);
        assert_eq!(c.active_payment_id, None);
        assert_eq!(c.daily_usage[0].reserved_yocto, 0);
    }

    #[test]
    fn payment_view_serializes_u64_values_as_exact_json_strings() {
        let payment = Payment {
            id: 42,
            agent_id: account("agent.testnet"),
            recipient_id: account("merchant.testnet"),
            amount_yocto: 123,
            nonce: 42,
            created_at_ns: 1_793_519_712_345_678_901,
            expires_at_ns: 1_793_520_012_345_678_901,
            status: PaymentStatus::Pending,
            hardware_approved: false,
        };

        let json = near_sdk::serde_json::to_value(payment_to_view(&payment)).unwrap();
        assert_eq!(json["created_at_ns"], "1793519712345678901");
        assert_eq!(json["expires_at_ns"], "1793520012345678901");
        assert_eq!(json["id"], "42");
        assert_eq!(json["nonce"], "42");
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
