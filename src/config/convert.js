const util = require('util')
const log = require('electron-log')

const sectionAlias = [
  ['RoutingRule', 'Rule'],
]

const getSection = (line) => {
  const re = /^\s*\[\s*([^\]]*)\s*\]\s*$/
  if (re.test(line)) {
    return line.match(re)[1]
  } else {
    return ""
  }
}

const equalSection = (s1, s2) => {
  s1 = s1.trim()
  s2 = s2.trim()
  for (var i = 0; i < sectionAlias.length; i++) {
    if (sectionAlias[i].includes(s1) && sectionAlias[i].includes(s2)) {
      return true
    }
  }
  return (s1 == s2)
}

const removeLineComments = (s) => {
  return s.replace(/;[^*]*/g, '')
}

const getLinesBySection = (conf, sect) => {
  var lines = []
  var currSect = ''
  conf.match(/[^\r\n]+/g).forEach((line) => {
    line = removeLineComments(line)
    const s = getSection(line)
    if (s.length != 0) {
      currSect = s
      return // next
    }
    if (equalSection(currSect, sect)) {
      line = line.trim()
      if (line.length != 0) {
        lines.push(line)
      }
    }
  })
  return lines
}

const equalRuleType = (t1, t2) => {
  if (t1.includes('DOMAIN') && t2.includes('DOMAIN')) {
    return true
  }
  if (t1.includes('IP') && t2.includes('IP')) {
    return true
  }
  if (t1 == t2) {
    return true
  }
  return false
}

const ruleName = (type) => {
  if (type.includes('DOMAIN')) {
    return 'domain'
  } else if (type.includes('IP')) {
    return 'ip'
  } else if (type.includes('PROCESS')) {
    return 'app'
  } else if (type.includes('PORT')) {
    return 'port'
  } else if (type.includes('NETWORK')) {
    return 'network'
  } else {
    return new Error('invalid rule type')
  }
}

const nonListType = (type) => {
  if (type.includes('PORT') || type.includes('NETWORK') || type.includes('FINAL')) {
    return true
  }
  return false
}

const ruleFilter = (type, filters) => {
  if (nonListType(type)) {
    if (filters.length > 1) {
      return new Error('more that 1 filter in non-list type rule')
    }
    return filters[0]
  } else {
    return filters
  }
}

const isBalancerTag = (tag, balancers) => {
  for (var i = 0; i < balancers.length; i++) {
    if (balancers[i].tag == tag) {
      return true
    }
  }
  return false
}

const constructRouting = (strategy, balancer, rule, dns) => {
  var routing = { balancers: [], rules: [] }

  strategy.forEach((line) => {
    line = line.trim()
    if (line.length != 0) {
      routing.domainStrategy = line
    }
  })

  balancer.forEach((line) => {
    const parts = line.trim().split(',')
    if (parts.length < 2) {
      return // next
    }
    const tag = parts[0].trim()
    const selectors = parts[1].trim().split(':').map(x => x.trim())
    var bnc = {
      tag: tag,
      selector: selectors
    }
    if (parts.length > 2) {
      bnc.strategy = parts[2].trim()
    }
    switch (bnc.strategy) {
      case 'latency':
        const params = parts.slice(3, parts.length)
        params.forEach((p) => {
          const ps = p.trim().split('=')
          if (ps.length != 2) {
            return // next
          }
          key = ps[0].trim()
          val = ps[1].trim()
          switch (key) {
            case 'timeout':
            case 'interval':
            case 'delay':
            case 'tolerance':
            case 'totalMeasures':
              bnc[key] = parseInt(val)
              break
            default:
              bnc[key] = val
          }
        })
        break
    }
    routing.balancers.push(bnc)
  })

  var lastType = ''
  var lastTarget = ''
  var filters = []
  rule.forEach((line) => {
    const parts = line.trim().split(',')
    if (parts.length < 2) {
      return // next
    }
    const type = parts[0].trim()
    const target = parts[parts.length-1].trim()
    if (filters.length > 0 && (nonListType(type) || !equalRuleType(type, lastType) || target !== lastTarget)) {
      var r = {
        type: 'field',
      }
      if (isBalancerTag(lastTarget, routing.balancers)) {
        r['balancerTag'] = lastTarget
      } else {
        r['outboundTag'] = lastTarget
      }
      r[ruleName(lastType)] = ruleFilter(lastType, filters)
      routing.rules.push(r)
      lastType = ''
      lastTarget = ''
      filters = []
    }
    if (type !== 'FINAL') {
      if (parts.length != 3) {
        return // next
      }
    } else {
      if (parts.length != 2) {
        return // next
      }
    }
    lastType = type
    lastTarget = target
    var filter = parts[1].trim()
    switch (type) {
      case 'DOMAIN-KEYWORD':
        filters.push(filter)
        break
      case 'DOMAIN-FULL':
        filters.push(util.format('domain:%s', filter))
        break
      case 'IP-CIDR':
        filters.push(filter)
        break
      case 'GEOIP':
        filters.push(util.format('geoip:%s', filter))
        break
      case 'PORT':
        filters.push(filter)
        break
      case 'PROCESS-NAME':
        filters.push(filter)
        break
      case 'FINAL':
        if (routing.domainStrategy == 'IPIfNonMatch' || routing.domainStrategy == 'IPOnDemand') {
          filters.push('0.0.0.0/0')
          filters.push('::/0')
          lastType = 'IP-CIDR'
        } else {
          filters.push('tcp,udp')
          lastType = 'NETWORK'
        }
        break
    }
  })
  if (filters.length > 0) {
    var r = {
      type: 'field',
    }
    if (isBalancerTag(lastTarget, routing.balancers)) {
      r['balancerTag'] = lastTarget
    } else {
      r['outboundTag'] = lastTarget
    }
    r[ruleName(lastType)] = ruleFilter(lastType, filters)
    routing.rules.push(r)
  }

  dns.forEach((line) => {
    const parts = line.trim().split('=')
    if (parts.length != 2) {
      return // next
    }
    const k = parts[0].trim()
    const v = parts[1].trim()
    if (k == 'hijack' && v.length > 0) {
      routing.rules.unshift({
        type: 'field',
        outboundTag: v,
        inboundTag: ['tun2socks'],
        network: 'udp',
        port: 53
      })
    }
  })

  if (routing.balancers.length == 0) {
    delete routing.balancers
  }
  if (routing.rules.length == 0) {
    delete routing.rules
  }
  return routing
}

const constructDns = (server, rule, host, clientIp) => {
  var dns = { servers: [] }

  if (clientIp.length == 1) {
    const ip = clientIp[0].trim()
    if (ip.length > 0) {
      dns.clientIp =  ip
    }
  }

  host.forEach((line) => {
    const parts = line.trim().split('=')
    if (parts.length != 2) {
      return // next
    }
    const domain = parts[0].trim()
    const ip = parts[1].trim()
    if (domain.length == 0 || ip.length == 0) {
      return // next
    }
    if (!dns.hasOwnProperty('hosts')) {
      dns.hosts = {}
    }
    dns.hosts[domain] = ip
  })

  var servers = []
  var rules = []

  rule.forEach((line) => {
    const parts = line.trim().split(',')
    if (parts.length != 3) {
      return // next
    }
    const type = parts[0].trim()
    var filter = parts[1].trim()
    const tag = parts[2].trim()
    switch (type) {
      case 'DOMAIN-FULL':
        filter = util.format('domain:%s', filter)
        break
    }
    rules.push({
      filter: filter,
      tag: tag
    })
  })

  server.forEach((line) => {
    const parts = line.trim().split(',')
    if (parts.length == 1) {
      servers.push({
        address: parts[0]
      })
    } else if (parts.length == 3) {
      var filters = []
      rules.forEach((r) => {
        if (r.tag == parts[2]) {
          filters.push(r.filter)
        }
      })
      servers.push({
        address: parts[0],
        port: parseInt(parts[1]),
        filters: filters
      })
    }
  })

  servers.forEach((s) => {
    if (s.hasOwnProperty('port') && s.hasOwnProperty('filters')) {
      dns.servers.push({
        address: s.address,
        port: parseInt(s.port),
        domains: s.filters
      })
    } else {
      dns.servers.push(s.address)
    }
  })
  if (dns.servers.length == 0) {
    delete dns.servers
  }
  return dns
}

const constructLog = (logLines) => {
  var log = {}
  logLines.forEach((line) => {
    const parts = line.trim().split('=')
    if (parts.length != 2) {
      return // next
    }
    switch (parts[0].trim()) {
      case 'loglevel':
        log.loglevel = parts[1].trim()
    }
  })
  return log
}

const freedomOutboundParser = (tag, params) => {
  var ob = {
    "protocol": "freedom",
    "tag": tag
  }
  params.forEach((param) => {
    const parts = param.trim().split('=')
    if (parts.length != 2) {
      return
    }
    if (!ob.hasOwnProperty('settings')) {
      ob.settings = {}
    }
    switch (parts[0].trim()) {
      case 'domainStrategy':
        ob.settings.domainStrategy = parts[1].trim()
        break
    }
  })
  return ob
}

const blackholeOutboundParser = (tag, params) => {
  return {
    "protocol": "blackhole",
    "tag": tag
  }
}

const dnsOutboundParser = (tag, params) => {
  return {
    "protocol": "dns",
    "tag": tag,
    "settings": {}
  }
}

const vmess1Parser = (tag, params) => {
  var ob = {
    "protocol": "vmess",
    "tag": tag,
    "settings": {
      "vnext": []
    },
    "streamSettings": {
    }
  }
  if (params.length > 1) {
    return new Error('invalid vmess1 parameters')
  }
  const url = new URL(params[0].trim())
  const uuid = url.username
  const address = url.hostname
  const port = url.port
  const path = url.pathname
  const query = url.search.substr(1)
  ob.settings.vnext.push({
    users: [{
      "id": uuid
    }],
    address: address,
    port: parseInt(port),
  })
  const parts = query.split('&')
  parts.forEach((q) => {
    const qps = q.split('=')
    switch (qps[0]) {
      case 'network':
        ob.streamSettings.network = qps[1]
        break
      case 'tls':
        if (qps[1] == 'true') {
          ob.streamSettings.security = 'tls'
        } else {
          ob.streamSettings.security = 'none'
        }
        break
    }
  })
  if (path.length != 0) {
    switch (ob.streamSettings.network) {
      case 'ws':
        if (!ob.streamSettings.hasOwnProperty('wsSettings')) {
          ob.streamSettings.wsSettings = {}
        }
        ob.streamSettings.wsSettings.path = path
        break
    }
  }
  return ob
}

const builtinParser = (tag, params) => {
  switch (params[0].trim()) {
    case 'freedom':
      return freedomOutboundParser(tag, params.slice(1, params.length))
    case 'blackhole':
      return blackholeOutboundParser(tag, params.slice(1, params.length))
    case 'dns':
      return dnsOutboundParser(tag, params.slice(1, params.length))
  }
}

const parsers = {
  builtin: builtinParser,
  vmess1: vmess1Parser
}

const constructOutbounds = (endpoint) => {
  var outbounds = []
  endpoint.forEach((line) => {
    const parts = line.trim().split(',')
    if (parts.length < 2) {
      return // next
    }
    const tag = parts[0].trim()
    const parser = parts[1].trim()
    const params = parts.slice(2, parts.length)
    const p = parsers[parser]
    if (p instanceof Function) {
      let outbound = p(tag, params)
      outbounds.push(outbound)
    } else {
      log.warn('parser not found: ', parser)
    }
  })
  return outbounds
}

const constructJson = (conf) => {
    const routingDomainStrategy = getLinesBySection(conf, 'RoutingDomainStrategy')
    const balancerRule = getLinesBySection(conf, 'EndpointGroup')
    const routingRule = getLinesBySection(conf, 'RoutingRule')
    const dnsConf = getLinesBySection(conf, 'Dns')
    const routing = constructRouting(routingDomainStrategy, balancerRule, routingRule, dnsConf)

    const dnsServer = getLinesBySection(conf, 'DnsServer')
    const dnsRule = getLinesBySection(conf, 'DnsRule')
    const dnsHost = getLinesBySection(conf, 'DnsHost')
    const dnsClientIp = getLinesBySection(conf, 'DnsClientIp')
    const dns = constructDns(dnsServer, dnsRule, dnsHost, dnsClientIp)

    const logLines = getLinesBySection(conf, 'Log')
    const log = constructLog(logLines)

    const endpoint = getLinesBySection(conf, 'Endpoint')
    const outbounds = constructOutbounds(endpoint)

    return {
      log: log,
      dns: dns,
      outbounds: outbounds,
      routing: routing
    }
}

module.exports = {
  getLinesBySection,
  constructRouting,
  constructDns,
  constructLog,
  constructOutbounds,
  constructJson
}
