import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import { Spinner } from "@medusajs/icons"
import { Badge, Button, Container, Heading, StatusBadge, Text, toast } from "@medusajs/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import {
  LIQPAY_PROVIDER_ID_PREFIX,
  type LiqPayLiveStatus,
  type StoredLiqPayData,
  formatDateTime,
  formatMoney,
  statusInfo,
} from "../lib/liqpay"
import { sdk } from "../lib/sdk"

type Order = HttpTypes.AdminOrder

type LiqPayPayment = {
  id: string
  provider_id: string
  amount: number
  currency_code: string
  data: StoredLiqPayData | null
}

const PAYMENT_FIELDS = [
  "id",
  "payment_collections.payments.id",
  "payment_collections.payments.provider_id",
  "payment_collections.payments.amount",
  "payment_collections.payments.currency_code",
  "payment_collections.payments.data",
].join(",")

function useLiqPayT() {
  const { t, i18n } = useTranslation("liqpay")
  const locale = i18n.language || "en"
  const status = (value: string | null | undefined) => {
    const info = statusInfo(value)
    return { color: info.color, label: t(info.key, { defaultValue: info.raw ?? "—" }) }
  }
  const paytype = (value: string | null | undefined) =>
    value ? t(`paytype.${value}`, { defaultValue: value }) : null
  return { t, locale, status, paytype }
}

// ------------------------------------------------------------------ widget

/**
 * Order page: LiqPay transaction details read from the payment's stored data, plus a
 * live status check against LiqPay. Renders nothing for orders without a LiqPay payment.
 */
const OrderLiqPayWidget = ({ data: order }: DetailWidgetProps<Order>) => {
  const { t } = useLiqPayT()
  // The order prop does not reliably carry payment data, so load it.
  const { data, isLoading, isError } = useQuery({
    queryKey: ["medusa-plugin-liqpay", "order", order.id],
    queryFn: () => sdk.admin.order.retrieve(order.id, { fields: PAYMENT_FIELDS }),
  })

  const payments = (data?.order.payment_collections ?? [])
    .flatMap((collection) => (collection.payments ?? []) as unknown as LiqPayPayment[])
    .filter((payment) => payment.provider_id?.startsWith(LIQPAY_PROVIDER_ID_PREFIX))

  if (isLoading) {
    return (
      <Container className="flex items-center gap-x-2 px-6 py-4">
        <Spinner className="text-ui-fg-muted animate-spin" aria-hidden />
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {t("loading")}
        </Text>
      </Container>
    )
  }

  if (isError) {
    return (
      <Container className="px-6 py-4">
        <Text size="small" leading="compact" className="text-ui-fg-error">
          {t("loadError")}
        </Text>
      </Container>
    )
  }

  if (!payments.length) {
    return null
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between gap-x-2 px-6 py-4">
        <Heading level="h2">{t("title")}</Heading>
        {payments.some((p) => p.data?.is_sandbox) && (
          <Badge size="2xsmall" color="orange">
            {t("sandbox")}
          </Badge>
        )}
      </div>
      {payments.map((payment) => (
        <LiqPayPaymentSection key={payment.id} payment={payment} />
      ))}
    </Container>
  )
}

// ----------------------------------------------------------------- payment

const LiqPayPaymentSection = ({ payment }: { payment: LiqPayPayment }) => {
  const { t, locale, status, paytype } = useLiqPayT()
  const stored = payment.data ?? {}
  const storedStatus = status(stored.status)
  const transactionId = stored.transaction_id ?? stored.liqpay_payment_id

  const check = useMutation({
    mutationFn: () =>
      sdk.client.fetch<{ liqpay_status: LiqPayLiveStatus }>(
        `/admin/liqpay/payments/${payment.id}/status`
      ),
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : t("checkError"))
    },
  })
  const live = check.data?.liqpay_status

  return (
    <div className="divide-y">
      <Row
        title={t("fields.status")}
        value={<StatusBadge color={storedStatus.color}>{storedStatus.label}</StatusBadge>}
      />
      <Row title={t("fields.transactionId")} value={transactionId ? String(transactionId) : "—"} />
      <Row title={t("fields.paytype")} value={paytype(stored.paytype) ?? "—"} />
      <Row title={t("fields.card")} value={stored.sender_card_mask2 ?? "—"} />
      <Row title={t("fields.orderId")} value={stored.session_id ?? "—"} />
      {stored.refunded_amount ? (
        <Row
          title={t("fields.refunded")}
          value={formatMoney(stored.refunded_amount, payment.currency_code, locale)}
        />
      ) : null}

      <div className="flex flex-col gap-y-3 px-6 py-4">
        <div className="flex items-center justify-between gap-x-2">
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("storedHint")}
          </Text>
          <Button
            size="small"
            variant="secondary"
            onClick={() => check.mutate()}
            isLoading={check.isPending}
            disabled={check.isPending}
          >
            {t("checkStatus")}
          </Button>
        </div>
        {live && <LiveStatus live={live} storedStatus={stored.status} />}
      </div>
    </div>
  )
}

// -------------------------------------------------------------- live check

const LiveStatus = ({
  live,
  storedStatus,
}: {
  live: LiqPayLiveStatus
  storedStatus: string | undefined
}) => {
  const { t, locale, status, paytype } = useLiqPayT()

  if (!live.found) {
    return (
      <Text size="small" leading="compact" className="text-ui-fg-error" role="status">
        {t("live.notFound", { time: formatDateTime(live.checked_at, locale) })}
      </Text>
    )
  }

  const info = status(live.status)
  const changed = Boolean(live.status && storedStatus && live.status !== storedStatus)

  return (
    <div
      className="bg-ui-bg-subtle shadow-elevation-card-rest flex flex-col gap-y-2 rounded-md px-4 py-3"
      role="status"
    >
      <div className="flex items-center justify-between gap-x-2">
        <Text size="small" leading="compact" weight="plus">
          {t("live.title")}
        </Text>
        <StatusBadge color={info.color}>{info.label}</StatusBadge>
      </div>
      {live.amount !== null && live.currency && (
        <LiveRow label={t("live.amount")} value={formatMoney(live.amount, live.currency, locale)} />
      )}
      {live.paytype && <LiveRow label={t("live.paytype")} value={paytype(live.paytype) ?? ""} />}
      {live.end_date && (
        <LiveRow label={t("live.lastChange")} value={formatDateTime(live.end_date, locale)} />
      )}
      {live.err_description && <LiveRow label={t("live.message")} value={live.err_description} />}
      <LiveRow label={t("live.checked")} value={formatDateTime(live.checked_at, locale)} />
      {changed && (
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {t("live.changed", { status: status(storedStatus).label })}
        </Text>
      )}
    </div>
  )
}

// ------------------------------------------------------------------- rows

const Row = ({ title, value }: { title: string; value: ReactNode }) => (
  <div className="text-ui-fg-subtle grid grid-cols-2 items-center px-6 py-4">
    <Text size="small" leading="compact" weight="plus">
      {title}
    </Text>
    {typeof value === "string" ? (
      <Text size="small" leading="compact" className="whitespace-pre-line text-pretty break-all">
        {value}
      </Text>
    ) : (
      <div className="flex flex-wrap gap-1">{value}</div>
    )}
  </div>
)

const LiveRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between gap-x-2">
    <Text size="small" leading="compact" className="text-ui-fg-subtle">
      {label}
    </Text>
    <Text size="small" leading="compact">
      {value}
    </Text>
  </div>
)

export const config = defineWidgetConfig({
  zone: "order.details.side.before",
})

export default OrderLiqPayWidget
