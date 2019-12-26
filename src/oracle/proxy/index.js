const express = require('express')
const BN = require('bignumber.js')
const ethers = require('ethers')

const { tokenAbi, bridgeAbi, sharedDbAbi } = require('./contractsAbi')
const {
  Ok, Err, decodeStatus, encodeParam, Action
} = require('./utils')
const encode = require('./encode')
const decode = require('./decode')
const logger = require('../shared/logger')
const { retry } = require('../shared/wait')
const createProvider = require('../shared/ethProvider')
const { connectRabbit, assertQueue } = require('../shared/amqp')
const { publicKeyToAddress, padZeros } = require('../shared/crypto')
const {
  parseNumber, parseAddress, parseBool, logRequest
} = require('./expressUtils')
const { getForeignBalances } = require('../shared/binanceClient')

const {
  HOME_RPC_URL, HOME_BRIDGE_ADDRESS, SIDE_RPC_URL, SIDE_SHARED_DB_ADDRESS, VALIDATOR_PRIVATE_KEY,
  HOME_TOKEN_ADDRESS, FOREIGN_ASSET, RABBITMQ_URL
} = process.env

const sideProvider = createProvider(SIDE_RPC_URL)
const homeProvider = createProvider(HOME_RPC_URL)
const sideWallet = new ethers.Wallet(VALIDATOR_PRIVATE_KEY, sideProvider)

const token = new ethers.Contract(HOME_TOKEN_ADDRESS, tokenAbi, homeProvider)
const bridge = new ethers.Contract(HOME_BRIDGE_ADDRESS, bridgeAbi, homeProvider)
const sharedDb = new ethers.Contract(SIDE_SHARED_DB_ADDRESS, sharedDbAbi, sideProvider)

const validatorAddress = sideWallet.address

let channel
let sideSendQueue

const app = express()
app.use(express.json({ strict: false }))
app.use(express.urlencoded({ extended: true }))

const votesProxyApp = express()

async function status(req, res) {
  const [bridgeEpoch, bridgeStatus] = await Promise.all([
    bridge.epoch(),
    bridge.status()
  ])
  res.send({
    bridgeEpoch,
    bridgeStatus
  })
}

async function get(req, res) {
  const tags = req.body.key.split('-')
  const fromId = parseInt(tags[0], 10)
  const round = tags[tags.length - 2]
  const uuid = tags[tags.length - 1]
  const to = tags.length === 4 ? tags[1] : ''
  let from
  if (uuid.startsWith('k')) {
    const validators = await bridge.getNextValidators()
    from = validators[fromId - 1]
  } else {
    const validators = await bridge.getValidators()
    from = await sharedDb.getSignupAddress(uuid, validators, fromId)
  }
  const key = ethers.utils.id(`${round}_${Number(to)}`)

  const data = await sharedDb.getData(from, ethers.utils.id(uuid), key)

  if (data.length > 2) {
    logger.trace(`Received encoded data: ${data}`)
    const decoded = decode(uuid[0] === 'k', round, data)
    logger.trace('Decoded data: %o', decoded)
    res.send(Ok({
      key: req.body.key,
      value: decoded
    }))
  } else {
    setTimeout(() => res.send(Err(null)), 1000)
  }
}

function sendJob(data) {
  sideSendQueue.send({
    data
  })
}

async function set(req, res) {
  const tags = req.body.key.split('-')
  const round = tags[tags.length - 2]
  const uuid = tags[tags.length - 1]
  const to = tags.length === 4 ? tags[1] : ''
  const key = ethers.utils.id(`${round}_${Number(to)}`)

  logger.trace('Received data: %o', req.body.value)
  const encoded = encode(uuid[0] === 'k', round, req.body.value)
  logger.trace(`Encoded data: ${encoded.toString('hex')}`)
  logger.trace(`Received data: ${req.body.value.length} bytes, encoded data: ${encoded.length} bytes`)
  const query = sharedDb.interface.functions.setData.encode([ethers.utils.id(uuid), key, encoded])
  sendJob(query)

  res.send(Ok(null))
}

async function signupKeygen(req, res) {
  const epoch = await bridge.nextEpoch()
  const partyId = await bridge.getNextPartyId(validatorAddress)

  logger.debug('Checking previous attempts')
  let attempt = 1
  let uuid
  while (true) {
    uuid = `k${epoch}_${attempt}`
    const data = await sharedDb.getData(validatorAddress, ethers.utils.id(uuid), ethers.utils.id('round1_0'))
    if (data.length === 2) {
      break
    }
    logger.trace(`Attempt ${attempt} is already used`)
    attempt += 1
  }
  logger.debug(`Using attempt ${attempt}`)

  if (partyId === 0) {
    res.send(Err({ message: 'Not a validator' }))
    logger.debug('Not a validator')
  } else {
    res.send(Ok({
      uuid,
      number: partyId
    }))
  }
}

async function signupSign(req, res) {
  const [, , msgHash] = req.body.split('-')

  logger.debug('Checking previous attempts')
  let attempt = 1
  let uuid
  let hash
  while (true) {
    uuid = `${msgHash}_${attempt}`
    hash = ethers.utils.id(uuid)
    const data = await sharedDb.isSignuped(hash, validatorAddress)
    if (!data) {
      break
    }
    logger.trace(`Attempt ${attempt} is already used`)
    attempt += 1
  }
  logger.debug(`Using attempt ${attempt}`)

  const query = sharedDb.interface.functions.signup.encode([hash])

  sendJob(query)
  const validators = await bridge.getValidators()
  const id = await retry(
    () => sharedDb.getSignupNumber(hash, validators, validatorAddress),
    -1,
    (signupId) => signupId > 0
  )

  res.send(Ok({
    uuid: hash,
    number: id
  }))
}

async function processMessage(type, ...params) {
  logger.debug(`Building message ${type}, %o`, params)
  const message = Buffer.concat([
    Buffer.from([type]),
    ...params.map(encodeParam)
  ])

  const signature = await sideWallet.signMessage(message)
  logger.debug('Adding signature to shared db contract')
  const query = sharedDb.interface.functions.addSignature.encode([`0x${message.toString('hex')}`, signature])
  sendJob(query)
}

async function confirmKeygen(req, res) {
  const { x, y, epoch } = req.body
  await processMessage(Action.CONFIRM_KEYGEN, epoch, padZeros(x, 64), padZeros(y, 64))
  res.send()
}

async function confirmFundsTransfer(req, res) {
  const { epoch } = req.body
  await processMessage(Action.CONFIRM_FUNDS_TRANSFER, epoch)
  res.send()
}

async function confirmCloseEpoch(req, res) {
  const { epoch } = req.body
  await processMessage(Action.CONFIRM_CLOSE_EPOCH, epoch)
  res.send()
}

async function voteStartVoting(req, res) {
  const epoch = await bridge.epoch()
  await processMessage(Action.VOTE_START_VOTING, epoch)
  res.send('Voted\n')
}

async function voteStartKeygen(req, res) {
  const epoch = await bridge.epoch()
  await processMessage(
    Action.VOTE_START_KEYGEN,
    epoch,
    padZeros(req.attempt.toString(16), 58)
  )
  res.send('Voted\n')
}

async function voteCancelKeygen(req, res) {
  const epoch = await bridge.nextEpoch()
  await processMessage(
    Action.VOTE_CANCEL_KEYGEN,
    epoch,
    padZeros(req.attempt.toString(16), 58)
  )
  res.send('Voted\n')
}

async function voteAddValidator(req, res) {
  const epoch = await bridge.epoch()
  await processMessage(
    Action.VOTE_ADD_VALIDATOR,
    epoch,
    req.validator,
    padZeros(req.attempt.toString(16), 18)
  )
  res.send('Voted\n')
}

async function voteChangeThreshold(req, res) {
  const epoch = await bridge.epoch()
  await processMessage(
    Action.VOTE_CHANGE_THRESHOLD,
    epoch,
    req.threshold,
    padZeros(req.attempt.toString(16), 54)
  )
  res.send('Voted\n')
}

async function voteChangeRangeSize(req, res) {
  const epoch = await bridge.epoch()
  await processMessage(
    Action.VOTE_CHANGE_RANGE_SIZE,
    epoch,
    req.rangeSize,
    padZeros(req.attempt.toString(16), 54)
  )
  res.send('Voted\n')
}

async function voteChangeCloseEpoch(req, res) {
  const epoch = await bridge.epoch()
  await processMessage(
    Action.VOTE_CHANGE_CLOSE_EPOCH,
    epoch,
    req.closeEpoch,
    padZeros(req.attempt.toString(16), 56)
  )
  res.send('Voted\n')
}

async function voteRemoveValidator(req, res) {
  const epoch = await bridge.epoch()
  await processMessage(
    Action.VOTE_REMOVE_VALIDATOR,
    epoch,
    req.validator,
    padZeros(req.attempt.toString(16), 18)
  )
  res.send('Voted\n')
}

async function transfer(req, res) {
  logger.info('Transfer start')
  const {
    hash, to, value, epoch
  } = req.body
  if (ethers.utils.isHexString(to, 20)) {
    logger.info(`Calling transfer to ${to}, 0x${value} tokens`)
    await processMessage(Action.TRANSFER, epoch, hash, to, padZeros(value, 24))
  }
  res.send()
  logger.info('Transfer end')
}

async function info(req, res) {
  try {
    const [
      x, y, epoch, rangeSize, nextRangeSize, closeEpoch, nextCloseEpoch, epochStartBlock,
      foreignNonce, nextEpoch, threshold, nextThreshold, validators, nextValidators, bridgeStatus,
      homeBalance
    ] = await Promise.all([
      bridge.getX()
        .then((value) => new BN(value).toString(16)),
      bridge.getY()
        .then((value) => new BN(value).toString(16)),
      bridge.epoch(),
      bridge.getRangeSize(),
      bridge.getNextRangeSize(),
      bridge.getCloseEpoch(),
      bridge.getNextCloseEpoch(),
      bridge.getStartBlock(),
      bridge.getNonce(),
      bridge.nextEpoch(),
      bridge.getThreshold(),
      bridge.getNextThreshold(),
      bridge.getValidators(),
      bridge.getNextValidators(),
      bridge.status(),
      token.balanceOf(HOME_BRIDGE_ADDRESS)
        .then((value) => parseFloat(new BN(value).dividedBy(10 ** 18)
          .toFixed(8, 3)))
    ])
    const foreignAddress = publicKeyToAddress({
      x,
      y
    })
    const balances = await getForeignBalances(foreignAddress)
    const msg = {
      epoch,
      rangeSize,
      nextRangeSize,
      epochStartBlock,
      nextEpoch,
      threshold,
      nextThreshold,
      closeEpoch,
      nextCloseEpoch,
      homeBridgeAddress: HOME_BRIDGE_ADDRESS,
      foreignBridgeAddress: foreignAddress,
      foreignNonce,
      validators,
      nextValidators,
      homeBalance,
      foreignBalanceTokens: parseFloat(balances[FOREIGN_ASSET]) || 0,
      foreignBalanceNative: parseFloat(balances.BNB) || 0,
      bridgeStatus: decodeStatus(bridgeStatus)
    }
    logger.trace('%o', msg)
    res.send(msg)
  } catch (e) {
    logger.debug('%o', e)
    res.send({
      message: 'Something went wrong, resend request',
      error: e
    })
  }
}


app.use('/', logRequest)
app.get('/status', status)

app.post('/get', get)
app.post('/set', set)
app.post('/signupkeygen', signupKeygen)
app.post('/signupsign', signupSign)

app.post('/confirmKeygen', confirmKeygen)
app.post('/confirmFundsTransfer', confirmFundsTransfer)
app.post('/confirmCloseEpoch', confirmCloseEpoch)
app.post('/transfer', transfer)

votesProxyApp.use('/', logRequest)

votesProxyApp.get('/vote/startVoting', voteStartVoting)

votesProxyApp.use('/vote', parseNumber(true, 'attempt', 0))

votesProxyApp.get('/vote/startKeygen', voteStartKeygen)
votesProxyApp.get('/vote/cancelKeygen', voteCancelKeygen)
votesProxyApp.get('/vote/addValidator/:validator', parseAddress('validator'), voteAddValidator)
votesProxyApp.get('/vote/removeValidator/:validator', parseAddress('validator'), voteRemoveValidator)
votesProxyApp.get('/vote/changeThreshold/:threshold', parseNumber(false, 'threshold'), voteChangeThreshold)
votesProxyApp.get('/vote/changeRangeSize/:rangeSize', parseNumber(false, 'rangeSize'), voteChangeRangeSize)
votesProxyApp.get('/vote/changeCloseEpoch/:closeEpoch', parseBool('closeEpoch'), voteChangeCloseEpoch)
votesProxyApp.get('/info', info)

async function main() {
  channel = await connectRabbit(RABBITMQ_URL)
  sideSendQueue = await assertQueue(channel, 'sideSendQueue')

  logger.warn(`My validator address in home and side networks is ${validatorAddress}`)

  app.listen(8001, () => {
    logger.debug('Proxy is listening on port 8001')
  })

  votesProxyApp.listen(8002, () => {
    logger.debug('Votes proxy is listening on port 8002')
  })
}

main()
