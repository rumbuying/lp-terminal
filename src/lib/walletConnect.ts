export const WALLET_PICKER_EVENT = 'lp-terminal:open-wallet-picker'

export const openWalletPicker = () => window.dispatchEvent(new Event(WALLET_PICKER_EVENT))
