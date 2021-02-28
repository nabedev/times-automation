import TimesCarShare from './times-car-share'

(async() => {
  process.on('unhandledRejection', (reason) => { throw reason })
  
  const times = new TimesCarShare()
  // times.prompt() // entry point
  times.prompt().catch(e => console.log(e))
})()
