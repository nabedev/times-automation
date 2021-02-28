import puppeteer, { ElementHandle } from 'puppeteer'
import prompts from 'prompts'
import dayjs, { Dayjs } from 'dayjs'
import { resolve } from 'path'
import { DH_NOT_SUITABLE_GENERATOR } from 'constants'

type TaskType = 'reservation' | 'observe' | 'availableCars'

interface Config {
  stationList: string[]
  resucheduleOffset: number
}

interface AvailableResult {
  carName: string
  gusStatus: '△' | '○'
  isAvailable: boolean
}

type AnswerKeys = 'taskType' | 'drivingDate' | 'drivingTime'

export default class TimesCarShare {
  config: Config

  stations: string[]

  constructor() {
    // FIXME
    this.stations = [
      'https://share.timescar.jp/view/reserve/input.jsp?scd=U882',
      'https://share.timescar.jp/view/reserve/input.jsp?scd=V558',
      'https://share.timescar.jp/view/reserve/input.jsp?scd=CU30',
      'https://share.timescar.jp/view/reserve/input.jsp?scd=CN94',
      'https://share.timescar.jp/view/reserve/input.jsp?scd=Q186',
    ]
  }

  async prompt() {
    const questions: prompts.PromptObject<AnswerKeys>[] = [
      {
        type: 'select',
        name: 'taskType',
        choices: [
          {
            title: 'reservation',
            description: '予約をします',
            value: 'reservation',
          },
          {
            title: 'observe',
            description: '監視をして自動延長をします',
            value: 'observe',
          },
          {
            title: 'availables',
            description: '予約可能な車一覧を表示します',
            value: 'availables',
          },
        ],
        message: 'Select task type',
      },
      {
        type: (prev: TaskType) => (prev == 'reservation' ? 'date' : null),
        name: 'drivingDate',
        message: 'When?',
        mask: 'YYYY-MM-DD HH:mm',
        format: (date: Date) => dayjs(date),
        initial: new Date(),
        validate: (ms: number) => {
          return (
            ms > Date.now() && // is feature
            new Date(ms).getMinutes() % 15 === 0 // step is 15 min
          )
        },
      },
      {
        type: (prev: Date) => (prev instanceof dayjs ? 'number' : null),
        name: 'drivingTime',
        initial: 15,
        min: 15,
        max: 720, // NOTE: It depends on the size of the timetable that can be displayed at one time. Searching across multiple pages is a hassle.
        increment: 15,
        message: 'How long?',
      },
    ]
    // let response = await prompts(questions)
    let response = {
      'taskType': 'reservation',
      'drivingDate': dayjs('2021-01-02 14:30'),
      drivingTime: 90
    }
    // console.log(response)
    await this.beginControlByUserInput(response)
  }

  async beginControlByUserInput(input: prompts.Answers<AnswerKeys>) {
    const page = await this.launch()
    await this.login(page)

    switch (input.taskType) {
      case 'reservation':
        await this.reservation(page, input.drivingDate, input.drivingTime)
        break
      case 'observe':
        await this.observe()
        break
    }
  }

  async launch(): Promise<puppeteer.Page> {
    const browser = await puppeteer.launch({
      headless: process.env.NODE_ENV === 'batch',
      defaultViewport: null,
      args:['--window-size=960,1080']
      // args: ['--auto-open-devtools-for-tabs'],
    })
    return await browser.newPage()
  }

  async login(page: puppeteer.Page) {
    const navigationPromise = page.waitForNavigation()

    await page.goto(
      'https://api.timesclub.jp/view/pc/tpLogin.jsp?siteKbn=TP&doa=ON&redirectPath=https%3A%2F%2Fshare.timescar.jp%2Fview%2Fmember%2Fmypage.jsp'
    )

    await page.waitForSelector('#d_contents > #login_area #cardNo1')
    await page.type(
      '#d_contents > #login_area #cardNo1',
      process.env.TIMES_CARDNUM_1
    )

    await page.waitForSelector('#d_contents > #login_area #cardNo2')
    await page.type(
      '#d_contents > #login_area #cardNo2',
      process.env.TIMES_CARDNUM_2
    )

    await page.waitForSelector('#d_contents > #login_area #tpPassword')
    await page.type(
      '#d_contents > #login_area #tpPassword',
      process.env.TIMES_PASSWORD
    )

    page.on('response', (response) => {
      const requestURL = response.request().url()
      if (requestURL !== 'https://api.timesclub.jp/view/pc/tpLogin.jsp') return
      if (
        response.headers()['Location'] ===
        'https://api.timesclub.jp/view/error/error.jsp'
      )
        throw new Error('Login failed')
      console.log('Login Success')
    })

    await page.waitForSelector(
      '#tpLoginForm > #d_contents > #login_area #doLoginForTp'
    )
    await page.click('#tpLoginForm > #d_contents > #login_area #doLoginForTp')

    await navigationPromise

    await page.waitForSelector(
      '#d_page > #isUnregistContractor-announce > #info_box > .info_message > .s_close'
    )
    await page.click(
      '#d_page > #isUnregistContractor-announce > #info_box > .info_message > .s_close'
    )
  }

  async reservation(
    page: puppeteer.Page,
    drivingDate: dayjs.Dayjs,
    drivingTime: number
  ) {
    // ステーション毎
    // 車一覧

    // ステーション毎の情報フェッチ
    let stationInformation = []
    for (let station of this.stations) {
      await page.goto(station, { waitUntil: 'load' })

      const info = await this.detectAvailability(page, drivingDate, drivingTime)
      stationInformation.push(info)
    }

    const util = require('util')
    // プロンプト返す
    console.log(util.inspect(stationInformation, false, null))

  }

  async observe() {
    // 予約監視
  }

  async resuchedule() {
    // 予約延長
  }

  async cancel() {}

  async _detectTimeTableAvailable(timeBlocks: ElementHandle[], begin: number, end: number): Promise<boolean> {
    const beginTimeBlock = [...timeBlocks][begin]
    const isFreeAtBegin = await beginTimeBlock.evaluate(el => el.classList.contains('vacant'))
    if (!isFreeAtBegin) {
      return false
    }
    const scanningTimeBlocks = [...timeBlocks].slice(begin, end+1)

    for (let timeBlock of scanningTimeBlocks) {
      if (!await timeBlock.evaluate(el => el.classList.contains('vacant'))) {
        return false
      }
    }
    return true
  }

  async detectAvailability(
    page: puppeteer.Page,
    drivingDate: dayjs.Dayjs,
    drivingTime: number
  ): Promise<{stationName: string, carInfo: AvailableResult[]}> {
    await page.waitForSelector(
      '#d_search > #isNotMannesStationOrOption #stationNm'
    )
    const stationName = await page.$eval(
      '#d_search > #isNotMannesStationOrOption #stationNm',
      (el) => el.textContent
    )

    // Display the timetable
    const navigationPromise = page.waitForNavigation()

    await page.waitForSelector('#isCanReserve > #d_infoarea #dateSpace')
    await page.click('#isCanReserve > #d_infoarea #dateSpace')

    await page.select(
      '#isCanReserve > #d_infoarea #dateSpace',
      `${drivingDate.format('YYYY-MM-DD')} 00:00:00.0`
    )

    await page.waitForSelector('#isCanReserve > #d_infoarea #hourSpace')
    await page.click('#isCanReserve > #d_infoarea #hourSpace')

    await page.select(
      '#isCanReserve > #d_infoarea #hourSpace',
      `${drivingDate.hour()}`
    )

    await page.waitForSelector(
      '#isCanReserve > #d_infoarea #doSearchTargetTimetable'
    )
    await page.click('#isCanReserve > #d_infoarea #doSearchTargetTimetable')

    await navigationPromise

    // parse for each car
    const tables = await page.$$('#timetableHtmlTag > div')
    let carInfo = []
    for (let table of tables) {
      const carName = await table.$eval('p.carname', el => el.textContent)
      const gusStatus = await table.$eval<'△' | '○'>('tbody > tr:nth-child(2) > td:nth-child(4)', el => el.textContent as '△' | '○')

      const beginTimeBlockIndex = drivingDate.minute() / 15
      const endTimeBlockIndex = (drivingDate.minute() + drivingTime) / 15

      const timeBlocks = await table.$$('table.time tr:last-child > td')
      const isAvailable = await this._detectTimeTableAvailable(timeBlocks, beginTimeBlockIndex, endTimeBlockIndex)

      carInfo.push({ carName, gusStatus, isAvailable, })
    }
    return { stationName, carInfo}
    // const results = await page.$$eval(
    //   '#timetableHtmlTag > div',
    //   (nodes, drivingDateMin, drivingTime) => {
    //     return nodes.map((node) => {
    //       const timeBlocks = node.querySelectorAll(
    //         'table.time tr:last-child > td'
    //       )
    //       const beginTimeBlockIndex = drivingDateMin / 15
    //       const endTimeBlockIndex = (drivingDateMin + drivingTime) / 15
    //       const isAvailable = this._detectTimeTableAvailable(timeBlocks, beginTimeBlockIndex, endTimeBlockIndex)

          // return {
          //   carName: node.querySelector('p.carname').textContent,
          //   gusStatus: node.querySelector(
          //     'tbody > tr:nth-child(2) > td:nth-child(4)'
          //   ).textContent as '△' | '○',
          //   isAvailable,
          // }
    //     })
    //   },
    //   drivingDate.minute() as 0 | 15 | 30 | 45,
    //   drivingTime
    // )
                                                                                                                                                                          

  }

  async reservationList() {}
}
