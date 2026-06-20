// 대시보드 공통 ECharts — 실제 사용하는 차트/컴포넌트만 등록해 번들을 줄인다.
// echarts 전체 정적 import(약 1.3MB) 대신 core + bar/line/pie + grid/tooltip/legend만. F-12.
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { TooltipComponent, LegendComponent, GridComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import ReactEChartsCore from 'echarts-for-react/lib/core';

echarts.use([BarChart, LineChart, PieChart, TooltipComponent, LegendComponent, GridComponent, CanvasRenderer]);

export default function ReactECharts(props) {
  return <ReactEChartsCore echarts={echarts} {...props} />;
}
