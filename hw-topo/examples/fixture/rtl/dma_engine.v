// DMA engine + non-ANSI port style testbench-style block.
`default_nettype none

module dma_engine (
    input  wire        clk_i,
    input  wire        rst_ni,
    output reg  [63:0] wdata_o,
    output reg  [31:0] addr_o,
    output reg         valid_o,
    input  wire        ready_i,
    output wire        error_o
);

    localparam integer MAX_BURST = 16;

    reg [3:0] burst_cnt;
    reg       busy;

    always @(posedge clk_i or negedge rst_ni) begin
        if (!rst_ni) begin
            burst_cnt <= 4'd0;
            busy      <= 1'b0;
            valid_o   <= 1'b0;
            wdata_o   <= 64'd0;
            addr_o    <= 32'd0;
        end else begin
            if (ready_i && valid_o) begin
                valid_o <= 1'b0;
                busy    <= 1'b0;
            end else if (!busy) begin
                valid_o <= 1'b1;
                busy    <= 1'b1;
                addr_o  <= addr_o + 32'd8;
                wdata_o <= {2{addr_o}};
            end
        end
    end

    assign error_o = 1'b0;

endmodule

// Non-ANSI style module (ports declared in the body).
module tb_hsb_top (clk, rst_n, done);

    input clk;
    input rst_n;
    output done;

    hsb_top #(.ADDR_W(32), .DATA_W(64)) dut (
        .clk_i      (clk),
        .rst_ni     (rst_n),
        .hsb_req_i  (1'b1),
        .hsb_gnt_o  (),
        .bench_stat_o (),
        .error_o    ()
    );

    assign done = 1'b1;

endmodule
