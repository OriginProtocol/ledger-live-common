import { Account, Address, Operation } from "../../../../types";
import {
  getCryptoCurrencyById,
  parseCurrencyUnit,
} from "../../../../currencies";
import { BigNumber } from "bignumber.js";
import { BroadcastTransactionRequest, TransactionResponse } from "./types";
import {
  GetAccountShape,
  GetAccountShapeArg0,
} from "../../../../bridge/jsHelpers";
import { fetchBalances, fetchBlockHeight, fetchTxs } from "./api";
import { encodeAccountId } from "../../../../account";
import flatMap from "lodash/flatMap";
import { Transaction } from "../../types";

type TxsById = {
  [id: string]: {
    Send: TransactionResponse;
    Fee?: TransactionResponse;
  };
};

export const getUnit = () => getCryptoCurrencyById("filecoin").units[0];

export const processTxs = (
  txs: TransactionResponse[]
): TransactionResponse[] => {
  const txsById = txs.reduce((result: TxsById, currentTx) => {
    const { hash, type } = currentTx;
    const txById = result[hash] || {};

    if (type == "Send" || type == "Fee") txById[type] = currentTx;

    result[hash] = txById;
    return result;
  }, {});

  const processedTxs: TransactionResponse[] = [];
  for (const txId in txsById) {
    const { Fee: feeTx, Send: sendTx } = txsById[txId];

    if (feeTx) sendTx.fee = feeTx.amount.toString();

    processedTxs.push(sendTx);
  }

  return processedTxs;
};

export const mapTxToOps =
  (id, { address }: GetAccountShapeArg0) =>
  (tx: TransactionResponse): Operation[] => {
    const { to, from, hash, timestamp, amount, fee } = tx;
    const ops: Operation[] = [];
    const date = new Date(timestamp * 1000);
    const value = parseCurrencyUnit(getUnit(), amount.toString());

    const isSending = address === from;
    const isReceiving = address === to;
    const feeToUse = new BigNumber(fee || 0);

    if (isSending) {
      ops.push({
        id: `${id}-${hash}-OUT`,
        hash,
        type: "OUT",
        value: value.plus(feeToUse),
        fee: feeToUse,
        blockHeight: tx.height,
        blockHash: null,
        accountId: id,
        senders: [from],
        recipients: [to],
        date,
        extra: {},
      });
    }

    if (isReceiving) {
      ops.push({
        id: `${id}-${hash}-IN`,
        hash,
        type: "IN",
        value,
        fee: feeToUse,
        blockHeight: tx.height,
        blockHash: null,
        accountId: id,
        senders: [from],
        recipients: [to],
        date,
        extra: {},
      });
    }

    return ops;
  };

export const getAddress = (a: Account): Address =>
  a.freshAddresses.length > 0
    ? a.freshAddresses[0]
    : { address: a.freshAddress, derivationPath: a.freshAddressPath };

export const getTxToBroadcast = (
  account: Account,
  transaction: Transaction,
  signature: string
): BroadcastTransactionRequest => {
  const { address } = getAddress(account);
  const {
    recipient,
    amount,
    gasLimit,
    gasFeeCap,
    gasPremium,
    method,
    version,
    nonce,
  } = transaction;

  return {
    message: {
      version,
      method,
      nonce,
      params: "",
      to: recipient,
      from: address,
      gaslimit: gasLimit.toNumber(),
      gaspremium: gasPremium.toString(),
      gasfeecap: gasFeeCap.toString(),
      value: amount.toFixed(),
    },
    signature: {
      type: 1,
      data: signature,
    },
  };
};

export const getAccountShape: GetAccountShape = async (info) => {
  const { address, currency } = info;

  const accountId = encodeAccountId({
    type: "js",
    version: "2",
    currencyId: currency.id,
    xpubOrAddress: address,
    derivationMode: "",
  });

  const blockHeight = await fetchBlockHeight();
  const balance = await fetchBalances(address);
  const rawTxs = await fetchTxs(address);

  const result = {
    id: accountId,
    balance: new BigNumber(balance.total_balance),
    spendableBalance: new BigNumber(balance.spendable_balance),
    operations: flatMap(processTxs(rawTxs), mapTxToOps(accountId, info)),
    blockHeight: blockHeight.current_block_identifier.index,
  };

  return result;
};
